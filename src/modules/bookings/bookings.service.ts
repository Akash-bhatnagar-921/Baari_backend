import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Booking, BookingServiceItem, BookingStatus } from './entities/booking.entity';
import { PushNotificationService } from '../users/push-notification.service';
import { EmailQueueService } from '../auth/services/email-queue.service';
import { SmsService } from '../auth/services/sms.service';

// Statuses that count as "occupying" a barber slot
const ACTIVE_STATUSES = `('pending', 'confirmed', 'in_progress')`;

// ── Auto-complete helper ───────────────────────────────────────────────────────
// Marks confirmed/in_progress bookings as completed when their time has passed.
// Called lazily before fetching bookings rather than via a cron job.

@Injectable()
export class BookingsService {
  constructor(
    private dataSource: DataSource,
    private push: PushNotificationService,
    private emailQueue: EmailQueueService,
    private sms: SmsService,
  ) {}

  private async autoCompleteOldBookings(filter: {
    userId?: string;
    salonId?: string;
  }) {
    const col = filter.userId ? '"userId"' : '"salonId"';
    const value = filter.userId ?? filter.salonId ?? '';
    await this.dataSource.query(
      `UPDATE bookings
       SET status = 'completed'
       WHERE status IN ('in_progress', 'confirmed')
         AND ${col} = $1
         AND "scheduledAt" + ("totalDuration" * INTERVAL '1 minute') < NOW() - INTERVAL '3 minutes'`,
      [value],
    );
  }

  // Marks PENDING bookings as EXPIRED when the professional hasn't responded
  // within 2 minutes of creation. Called lazily before fetching bookings.
  private async autoExpirePendingBookings(filter: {
    userId?: string;
    salonId?: string;
  }) {
    const col = filter.userId ? '"userId"' : '"salonId"';
    const value = filter.userId ?? filter.salonId ?? '';
    const expired: Array<{ id: string; userId: string; salonName: string }> =
      await this.dataSource.query(
        `UPDATE bookings
         SET status = 'expired', "bookingOtp" = NULL
         WHERE status = 'pending'
           AND ${col} = $1
           AND "createdAt" < NOW() - INTERVAL '2 minutes'
         RETURNING id, "userId", "salonName"`,
        [value],
      );
    if (expired.length > 0) {
      setImmediate(async () => {
        for (const b of expired) {
          await this.push
            .sendToUser(
              b.userId,
              'Booking Request Expired',
              `Your booking request at ${b.salonName} was not responded to in time and has expired. Please try again.`,
              { bookingId: b.id, type: 'booking_expired' },
            )
            .catch(() => {});
        }
      });
    }
  }

  // ── Available Slots (5-min intervals, single DB query) ───────────────────────

  // 3-letter JS day names matching the workingDays stored format (Mon, Tue … Sun)
  private static readonly DAY_NAMES = [
    'Sun',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
  ];

  async getAvailableSlots(salonId: string, date: string) {
    const rows = await this.dataSource.query(
      `SELECT s."openingTime", s."closingTime", s."workingDays",
              COALESCE((SELECT COUNT(*) FROM barbers b WHERE b."salonId" = s.id), 1)::int AS "barberCount"
       FROM salons s WHERE s.id = $1::uuid`,
      [salonId],
    );
    if (!rows.length) return [];

    const { openingTime, closingTime, workingDays, barberCount } = rows[0];
    const barbers = Math.max(1, barberCount);

    const [year, month, day] = date.split('-').map(Number);

    // ── Working-day guard ────────────────────────────────────────────────────
    // workingDays is stored as e.g. "Mon,Tue,Wed,Thu,Fri,Sat".
    // If the field is set and the requested date is NOT in that list, return
    // an empty array so the client knows no slots exist on this day.
    if (workingDays && (workingDays as string).trim().length > 0) {
      const requestedDayName =
        BookingsService.DAY_NAMES[new Date(year, month - 1, day).getDay()];
      const allowed = (workingDays as string)
        .split(',')
        .map((d: string) => d.trim());
      if (!allowed.includes(requestedDayName)) {
        return []; // salon is closed on this day
      }
    }

    const [oH, oM] = (openingTime ?? '09:00').split(':').map(Number);
    const [cH, cM] = (closingTime ?? '21:00').split(':').map(Number);

    // Fetch all active bookings for this salon on this day in ONE query
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);

    const existingBookings: Array<{
      scheduledAt: string;
      totalDuration: number;
    }> = await this.dataSource.query(
      `SELECT "scheduledAt", "totalDuration" FROM bookings
         WHERE "salonId" = $1
           AND status IN ${ACTIVE_STATUSES}
           AND "scheduledAt" < $2
           AND "scheduledAt" + ("totalDuration" * INTERVAL '1 minute') > $3`,
      [salonId, dayEnd.toISOString(), dayStart.toISOString()],
    );

    const now = new Date();
    const slots: any[] = [];

    for (let min = oH * 60 + oM; min < cH * 60 + cM; min += 5) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      const slotTime = new Date(year, month - 1, day, h, m, 0, 0);

      // Skip slots fewer than 5 minutes in the future
      if (slotTime.getTime() - now.getTime() < 5 * 60 * 1000) continue;

      // Count barbers busy at this slot (in-memory)
      const busy = existingBookings.filter((b) => {
        const bStart = new Date(b.scheduledAt);
        const bEnd = new Date(
          bStart.getTime() + Number(b.totalDuration) * 60_000,
        );
        return bStart <= slotTime && bEnd > slotTime;
      }).length;

      // Only emit available slots
      if (busy < barbers) {
        slots.push({
          time: slotTime.toISOString(),
          displayTime: `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`,
          available: true,
          remainingSlots: barbers - busy,
        });
      }
    }

    return slots;
  }

  // ── Create Booking (status: PENDING) ─────────────────────────────────────────

  /**
   * Returns a stable 32-bit positive integer for a given (salonId, slot).
   * Used as the key for pg_advisory_xact_lock so that concurrent requests for
   * the same salon+slot serialise against each other while different slots
   * proceed in parallel.
   */
  private slotLockKey(salonId: string, slotDate: Date): number {
    // Truncate to the 5-minute slot boundary (matches slot-picker granularity).
    const slotMinute = Math.floor(slotDate.getTime() / (5 * 60_000));
    const combined   = `${salonId}:${slotMinute}`;
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      hash = (Math.imul(31, hash) + combined.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 2_147_483_647; // fits in a PostgreSQL bigint
  }

  async createBooking(
    userId: string,
    salonId: string,
    scheduledAt: string,
    services: BookingServiceItem[],
    salonName: string,
  ) {
    if (!services?.length) {
      throw new BadRequestException('Please select at least one service.');
    }

    const scheduledDate = new Date(scheduledAt);
    if (scheduledDate.getTime() - Date.now() < 5 * 60 * 1000) {
      throw new BadRequestException(
        'Booking time must be at least 5 minutes in the future.',
      );
    }

    // Free plan: max 2 active (non-rejected, non-cancelled) bookings per month.
    // A row with status='cancelled' is treated as free regardless of plan value.
    const subRows = await this.dataSource.query(
      `SELECT plan, status FROM subscriptions WHERE "userId" = $1`,
      [userId],
    );
    const isFreePlan =
      !subRows[0] ||
      subRows[0].plan === 'free' ||
      subRows[0].status === 'cancelled';
    if (isFreePlan) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const countRows = await this.dataSource.query(
        `SELECT COUNT(*) AS cnt FROM bookings
         WHERE "userId" = $1 AND status NOT IN ('cancelled','rejected') AND "createdAt" >= $2`,
        [userId, monthStart.toISOString()],
      );
      if (parseInt(countRows[0]?.cnt ?? '0') >= 2) {
        throw new BadRequestException(
          'FREE_PLAN_LIMIT: Free plan allows up to 2 bookings per month. Upgrade to Basic or Pro for unlimited bookings.',
        );
      }
    }

    // Free-tier salon limit: if the salon's professional is on the free plan,
    // they can receive at most 50 bookings per calendar month.
    const salonSubRows = await this.dataSource.query(
      `SELECT sub.plan, sub.status, sub."expiresAt"
       FROM subscriptions sub
       JOIN salons s ON s."managerId" = sub."userId"::uuid
       WHERE s.id = $1::uuid`,
      [salonId],
    );
    const salonSub = salonSubRows[0];
    const salonIsFreePlan =
      !salonSub ||
      salonSub.plan === 'free' ||
      salonSub.status === 'cancelled' ||
      !String(salonSub.plan).startsWith('professional_') ||
      (salonSub.expiresAt && new Date() > new Date(salonSub.expiresAt));
    if (salonIsFreePlan) {
      const salonMonthStart = new Date();
      salonMonthStart.setDate(1);
      salonMonthStart.setHours(0, 0, 0, 0);
      const salonCountRows = await this.dataSource.query(
        `SELECT COUNT(*) AS cnt FROM bookings
         WHERE "salonId" = $1 AND status NOT IN ('cancelled','rejected') AND "createdAt" >= $2`,
        [salonId, salonMonthStart.toISOString()],
      );
      if (parseInt(salonCountRows[0]?.cnt ?? '0') >= 50) {
        throw new BadRequestException(
          'SALON_BOOKING_LIMIT: This salon has reached its monthly booking limit. Please try again next month or choose a different salon.',
        );
      }
    }

    // Block if user already has an active upcoming booking
    const activeRows = await this.dataSource.query(
      `SELECT 1 FROM bookings
       WHERE "userId" = $1 AND status IN ('pending','confirmed') AND "scheduledAt" > $2
       LIMIT 1`,
      [userId, new Date().toISOString()],
    );
    if (activeRows.length) {
      throw new BadRequestException(
        'ACTIVE_BOOKING: You already have an upcoming booking. Please cancel it before making a new one.',
      );
    }

    const serviceAmount  = services.reduce((s, i) => s + (i.price    ?? 0),  0);
    const convenienceFee = Math.round(serviceAmount * 0.03 * 100) / 100;
    const totalAmount    = serviceAmount + convenienceFee;
    const totalDuration  = services.reduce((s, i) => s + (i.duration ?? 30), 0);

    // ── Slot check + booking insert inside a serialised transaction ──────────
    // pg_advisory_xact_lock acquires a session-level exclusive lock keyed on
    // (salonId, 5-min slot).  Any concurrent request for the same key blocks
    // here until the first transaction commits or rolls back, eliminating the
    // check-then-insert race condition.
    const lockKey = this.slotLockKey(salonId, scheduledDate);

    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock($1)`, [lockKey]);

      // Re-read barber count and active bookings inside the lock.
      const barberRows = await manager.query(
        `SELECT COALESCE((SELECT COUNT(*) FROM barbers b WHERE b."salonId" = s.id), 1)::int AS cnt
         FROM salons s WHERE s.id = $1::uuid`,
        [salonId],
      );
      const barberCount = Math.max(1, parseInt(barberRows[0]?.cnt ?? '1'));

      const dayStart = new Date(scheduledDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(scheduledDate);
      dayEnd.setHours(23, 59, 59, 999);

      const busyRows = await manager.query(
        `SELECT "scheduledAt", "totalDuration" FROM bookings
         WHERE "salonId" = $1 AND status IN ${ACTIVE_STATUSES}
           AND "scheduledAt" < $2 AND "scheduledAt" + ("totalDuration" * INTERVAL '1 minute') > $3`,
        [salonId, dayEnd.toISOString(), dayStart.toISOString()],
      );
      const busy = busyRows.filter((b: any) => {
        const bStart = new Date(b.scheduledAt);
        const bEnd   = new Date(bStart.getTime() + Number(b.totalDuration) * 60_000);
        return bStart <= scheduledDate && bEnd > scheduledDate;
      }).length;

      if (busy >= barberCount) {
        throw new BadRequestException(
          'This slot just filled up. Please choose another time.',
        );
      }

      const booking = manager.getRepository(Booking).create({
        userId,
        salonId,
        salonName,
        scheduledAt: scheduledDate,
        totalAmount,
        convenienceFee,
        totalDuration,
        services,
        status: BookingStatus.PENDING,
      });
      const saved = await manager.getRepository(Booking).save(booking);

      // Fire-and-forget: confirmation email+SMS to customer
      setImmediate(() => this._notifyBookingCreated(userId, saved).catch(() => {}));
      return saved;
    });
  }

  // ── Notification helpers ──────────────────────────────────────────────────────

  private async _getUserContacts(userId: string): Promise<{ email?: string; phone?: string }> {
    const rows = await this.dataSource.query(
      `SELECT email, phone FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] ?? {};
  }

  private async _notifyBookingCreated(userId: string, booking: Booking) {
    const { email, phone } = await this._getUserContacts(userId);
    const dt = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    }).format(new Date(booking.scheduledAt));
    const serviceList = booking.services
      .map((s) => `${s.serviceName} (₹${s.price})`)
      .join(', ');
    const body = `Your booking at ${booking.salonName} on ${dt} has been sent for acceptance.\nServices: ${serviceList}`;

    if (email) {
      await this.emailQueue.enqueueLoginOtpEmail(email,
        `Booking request sent!\n\n${body}`).catch(() => {});
    }
    if (phone) await this.sms.sendOtp(phone, body.slice(0, 140)).catch(() => {});
  }

  private async _notifyBookingRejected(booking: Booking) {
    const { phone } = await this._getUserContacts(booking.userId);
    const dt = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    }).format(new Date(booking.scheduledAt));
    if (phone) {
      await this.sms.sendMessage(
        phone,
        `Baari: Your booking at ${booking.salonName} on ${dt} was not accepted. Please search for another salon.`,
      ).catch(() => {});
    }
  }

  private async _notifyBookingCancelled(booking: Booking) {
    const { phone } = await this._getUserContacts(booking.userId);
    const dt = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    }).format(new Date(booking.scheduledAt));
    if (phone) {
      await this.sms.sendMessage(
        phone,
        `Baari: Your booking at ${booking.salonName} on ${dt} has been cancelled.`,
      ).catch(() => {});
    }
  }

  private async _notifyBookingAccepted(booking: Booking) {
    const { email, phone } = await this._getUserContacts(booking.userId);
    const dt = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    }).format(new Date(booking.scheduledAt));
    const msg = `Your booking at ${booking.salonName} on ${dt} has been accepted! Your OTP is ${booking.bookingOtp}. Show it at the salon to begin.`;

    if (email) await this.emailQueue.enqueueLoginOtpEmail(email, msg).catch(() => {});
    if (phone) await this.sms.sendOtp(phone, `Baari OTP: ${booking.bookingOtp} for ${booking.salonName} on ${dt}`).catch(() => {});
    await this.push.sendToUser(booking.userId,
      'Booking Accepted! ✓',
      `Your OTP is ${booking.bookingOtp}. Show it at ${booking.salonName}.`,
      { bookingId: booking.id, type: 'booking_accepted' },
    );
  }

  // ── Professional: Accept ──────────────────────────────────────────────────────

  async acceptBooking(bookingId: string, professionalUserId: string) {
    const salonRows = await this.dataSource.query(
      `SELECT id FROM salons WHERE "managerId" = $1::uuid`,
      [professionalUserId],
    );
    if (!salonRows.length)
      throw new UnauthorizedException('No salon found for this account.');
    const salonId = salonRows[0].id as string;

    const repo = this.dataSource.getRepository(Booking);
    const booking = await repo.findOne({ where: { id: bookingId, salonId } });
    if (!booking) throw new NotFoundException('Booking not found.');
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Only pending bookings can be accepted.');
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    booking.status = BookingStatus.CONFIRMED;
    booking.bookingOtp = otp;
    const saved = await repo.save(booking);
    setImmediate(() => this._notifyBookingAccepted(saved).catch(() => {}));
    return saved;
  }

  // ── Professional: Reject ──────────────────────────────────────────────────────

  async rejectBooking(bookingId: string, professionalUserId: string) {
    const salonRows = await this.dataSource.query(
      `SELECT id FROM salons WHERE "managerId" = $1::uuid`,
      [professionalUserId],
    );
    if (!salonRows.length)
      throw new UnauthorizedException('No salon found for this account.');
    const salonId = salonRows[0].id as string;

    const repo = this.dataSource.getRepository(Booking);
    const booking = await repo.findOne({ where: { id: bookingId, salonId } });
    if (!booking) throw new NotFoundException('Booking not found.');
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Only pending bookings can be rejected.');
    }

    booking.status = BookingStatus.REJECTED;
    const saved = await repo.save(booking);
    setImmediate(() => {
      this.push.sendToUser(saved.userId,
        'Booking Not Accepted',
        `Your request at ${saved.salonName} was not accepted. You can search for another salon.`,
        { bookingId: saved.id, type: 'booking_rejected' },
      ).catch(() => {});
      this._notifyBookingRejected(saved).catch(() => {});
    });
    return saved;
  }

  // ── Professional: Verify OTP → start appointment ──────────────────────────────

  async verifyBookingOtp(
    bookingId: string,
    professionalUserId: string,
    otp: string,
  ) {
    const salonRows = await this.dataSource.query(
      `SELECT id FROM salons WHERE "managerId" = $1::uuid`,
      [professionalUserId],
    );
    if (!salonRows.length)
      throw new UnauthorizedException('No salon found for this account.');
    const salonId = salonRows[0].id as string;

    const repo = this.dataSource.getRepository(Booking);
    const booking = await repo.findOne({ where: { id: bookingId, salonId } });
    if (!booking) throw new NotFoundException('Booking not found.');
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        'Booking must be confirmed before starting.',
      );
    }
    if (booking.bookingOtp !== otp) {
      throw new BadRequestException(
        'Invalid OTP. Please check with the customer.',
      );
    }

    // OTP is valid for 60 minutes after the scheduled time
    const otpDeadline = new Date(
      booking.scheduledAt.getTime() + 60 * 60 * 1000,
    );
    if (new Date() > otpDeadline) {
      booking.status = BookingStatus.COMPLETED;
      await this.dataSource.getRepository(Booking).save(booking);
      throw new BadRequestException(
        'OTP has expired — the booking has been auto-completed.',
      );
    }

    booking.status = BookingStatus.IN_PROGRESS;
    booking.bookingOtp = null as any;
    booking.otpUsedAt = new Date();
    return repo.save(booking);
  }

  // ── Customer: Monthly booking count (for free-plan counter) ─────────────────
  // Returns the number of non-cancelled, non-rejected bookings created by the
  // user in the current calendar month.  Single COUNT query — cheap.

  async getMonthlyBookingCount(userId: string): Promise<{ count: number }> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const rows = await this.dataSource.query(
      `SELECT COUNT(*) AS cnt
       FROM bookings
       WHERE "userId" = $1
         AND status NOT IN ('cancelled', 'rejected')
         AND "createdAt" >= $2`,
      [userId, monthStart.toISOString()],
    );
    return { count: parseInt(rows[0]?.cnt ?? '0', 10) };
  }

  // ── Customer: Active booking check ───────────────────────────────────────────

  async getActiveBooking(userId: string) {
    const now = new Date();
    const rows = await this.dataSource.query(
      `SELECT b.*, s.name AS "liveSalonName", s.address, s.city
       FROM bookings b
       LEFT JOIN salons s ON s.id = b."salonId"::uuid
       WHERE b."userId" = $1
         AND b.status IN ('pending', 'confirmed')
         AND b."scheduledAt" > $2
       ORDER BY b."scheduledAt" ASC
       LIMIT 1`,
      [userId, now.toISOString()],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      salonId: r.salonId,
      salonName: r.salonName || r.liveSalonName || 'Salon',
      address: [r.address, r.city].filter(Boolean).join(', '),
      scheduledAt: r.scheduledAt,
      status: r.status,
      totalAmount: parseFloat(r.totalAmount),
      totalDuration: r.totalDuration,
      services: r.services,
      bookingOtp: r.status === 'confirmed' ? r.bookingOtp : null,
    };
  }

  // ── Professional: Complete a booking ────────────────────────────────────────

  async completeBooking(bookingId: string, professionalUserId: string) {
    const salonRows = await this.dataSource.query(
      `SELECT id FROM salons WHERE "managerId" = $1::uuid`,
      [professionalUserId],
    );
    if (!salonRows.length)
      throw new UnauthorizedException('No salon found for this account.');
    const salonId = salonRows[0].id as string;

    const repo = this.dataSource.getRepository(Booking);
    const booking = await repo.findOne({ where: { id: bookingId, salonId } });
    if (!booking) throw new NotFoundException('Booking not found.');
    if (!['confirmed', 'in_progress'].includes(booking.status)) {
      throw new BadRequestException(
        'Only confirmed or in-progress bookings can be completed.',
      );
    }
    booking.status = BookingStatus.COMPLETED;
    const saved = await repo.save(booking);
    setImmediate(() =>
      this.push.sendToUser(saved.userId,
        'Appointment Complete!',
        `Your visit to ${saved.salonName} is complete. Hope you enjoyed it! Leave a review.`,
        { bookingId: saved.id, type: 'booking_completed' },
      ).catch(() => {}),
    );
    return saved;
  }

  // ── User Bookings ─────────────────────────────────────────────────────────────

  async getUserBookings(userId: string, page = 1, limit = 20) {
    await this.autoExpirePendingBookings({ userId });
    await this.autoCompleteOldBookings({ userId });
    const now = new Date();
    const safePage  = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 50); // cap at 50 per page
    const offset = (safePage - 1) * safeLimit;

    const rows = await this.dataSource.query(
      `SELECT b.*, s.name AS "liveSalonName", s.address, s.city,
              EXISTS(
                SELECT 1 FROM reviews r
                WHERE r."userId" = b."userId" AND r."salonId" = b."salonId"
              ) AS "hasReview"
       FROM bookings b
       LEFT JOIN salons s ON s.id = b."salonId"::uuid
       WHERE b."userId" = $1
       ORDER BY b."scheduledAt" DESC
       LIMIT $2 OFFSET $3`,
      [userId, safeLimit, offset],
    );
    const mapped = rows.map((r: any) => {
      const isUpcoming =
        new Date(r.scheduledAt) > now &&
        !['cancelled', 'rejected', 'completed', 'expired'].includes(r.status);
      return {
        id: r.id,
        salonId: r.salonId,
        salonName: r.salonName || r.liveSalonName || 'Salon',
        address: [r.address, r.city].filter(Boolean).join(', '),
        scheduledAt: r.scheduledAt,
        status: r.status,
        totalAmount: parseFloat(r.totalAmount),
        totalDuration: r.totalDuration,
        services: r.services,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        isUpcoming,
        bookingOtp:
          r.status === 'confirmed' && isUpcoming ? r.bookingOtp : null,
        canModify:
          (r.status === 'confirmed' || r.status === 'pending') &&
          new Date(r.scheduledAt).getTime() - now.getTime() > 20 * 60 * 1000,
        hasReview: r.hasReview === true || r.hasReview === 't',
      };
    });

    const totalRows = await this.dataSource.query(
      `SELECT COUNT(*) AS cnt FROM bookings WHERE "userId" = $1`,
      [userId],
    );
    const total = parseInt(totalRows[0]?.cnt ?? '0', 10);

    return {
      bookings: mapped,
      pagination: { page: safePage, limit: safeLimit, total, hasMore: offset + safeLimit < total },
    };
  }

  // ── Professional: Earnings ───────────────────────────────────────────────────

  async getEarnings(userId: string) {
    const salonRows = await this.dataSource.query(
      `SELECT id FROM salons WHERE "managerId" = $1::uuid`,
      [userId],
    );
    if (!salonRows.length) return { stats: {}, bookings: [] };
    const salonId = salonRows[0].id as string;

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const statQuery = (since?: Date) =>
      this.dataSource.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM("totalAmount"), 0) AS revenue
         FROM bookings
         WHERE "salonId" = $1 AND status = 'completed'
           ${since ? `AND "scheduledAt" >= $2` : ''}`,
        since ? [salonId, since.toISOString()] : [salonId],
      );

    const [today, week, month, allTime, bookings] = await Promise.all([
      statQuery(todayStart),
      statQuery(weekStart),
      statQuery(monthStart),
      statQuery(),
      this.dataSource.query(
        `SELECT b."id", b."scheduledAt", b."totalAmount", b."totalDuration",
                b."services", u."fullName" AS "customerName"
         FROM bookings b
         LEFT JOIN users u ON u.id = b."userId"::uuid
         WHERE b."salonId" = $1 AND b.status = 'completed'
         ORDER BY b."scheduledAt" DESC
         LIMIT 60`,
        [salonId],
      ),
    ]);

    const parse = (r: any) => ({
      count: parseInt(r[0]?.cnt ?? '0', 10),
      revenue: parseFloat(r[0]?.revenue ?? '0'),
    });

    return {
      stats: {
        today: parse(today),
        week: parse(week),
        month: parse(month),
        allTime: parse(allTime),
      },
      bookings: bookings.map((b: any) => ({
        id: b.id,
        customerName: b.customerName || 'Customer',
        scheduledAt: b.scheduledAt,
        totalAmount: parseFloat(b.totalAmount),
        totalDuration: b.totalDuration,
        services: b.services,
      })),
    };
  }

  // ── Salon Bookings (Professional) ─────────────────────────────────────────────

  async getSalonBookings(userId: string) {
    const salonRows = await this.dataSource.query(
      `SELECT id FROM salons WHERE "managerId" = $1::uuid`,
      [userId],
    );
    if (!salonRows.length) return [];
    const salonId = salonRows[0].id;
    await this.autoExpirePendingBookings({ salonId });
    await this.autoCompleteOldBookings({ salonId });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86_400_000);

    const bookings = await this.dataSource.query(
      `SELECT b.*, u."fullName" AS "customerName", u.phone AS "customerPhone"
       FROM bookings b
       LEFT JOIN users u ON u.id = b."userId"::uuid
       WHERE b."salonId" = $1
       ORDER BY b."scheduledAt" DESC
       LIMIT 300`,
      [salonId],
    );

    // Today's stats — only appointments scheduled for today
    const todayRows = bookings.filter((b: any) => {
      const dt = new Date(b.scheduledAt);
      return dt >= today && dt < tomorrow && !['cancelled', 'rejected', 'expired'].includes(b.status);
    });

    // Active = appointments the professional still needs to act on (not yet done)
    const activeToday = todayRows.filter((b: any) =>
      ['pending', 'confirmed', 'in_progress'].includes(b.status),
    ).length;

    const completedToday = todayRows.filter(
      (b: any) => b.status === 'completed',
    ).length;

    const todayRevenue = todayRows
      .filter((b: any) => b.status === 'completed')
      .reduce((s: number, b: any) => s + parseFloat(b.totalAmount ?? '0'), 0);

    const pendingCount = todayRows.filter(
      (b: any) => b.status === 'pending',
    ).length;

    return {
      bookings,
      stats: {
        todayBookings: activeToday,      // active appointments needing attention
        completedToday,                   // done for the day
        todayRevenue: Math.round(todayRevenue * 100) / 100,
        pendingCount,
      },
    };
  }

  // ── Modify Services ───────────────────────────────────────────────────────────

  async modifyBookingServices(
    bookingId: string,
    userId: string,
    services: BookingServiceItem[],
  ) {
    if (!services?.length)
      throw new BadRequestException('Please select at least one service.');

    const repo = this.dataSource.getRepository(Booking);
    const booking = await repo.findOne({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found.');
    if (!['confirmed', 'pending'].includes(booking.status)) {
      throw new BadRequestException(
        'Only pending or confirmed bookings can be modified.',
      );
    }
    const minsUntil = (booking.scheduledAt.getTime() - Date.now()) / 60_000;
    if (minsUntil < 20) {
      throw new BadRequestException(
        'Bookings can only be modified more than 20 minutes before the scheduled time.',
      );
    }

    const reSvcAmount = services.reduce((s, i) => s + (i.price ?? 0), 0);
    booking.services       = services;
    booking.convenienceFee = Math.round(reSvcAmount * 0.03 * 100) / 100;
    booking.totalAmount    = reSvcAmount + booking.convenienceFee;
    booking.totalDuration  = services.reduce((s, i) => s + (i.duration ?? 30), 0);
    return repo.save(booking);
  }

  // ── Cancel Booking ────────────────────────────────────────────────────────────

  async cancelBooking(bookingId: string, userId: string, reason?: string) {
    const repo = this.dataSource.getRepository(Booking);
    const booking = await repo.findOne({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found.');
    if (!['confirmed', 'pending'].includes(booking.status)) {
      throw new BadRequestException(
        'Only pending or confirmed bookings can be cancelled.',
      );
    }
    const minsUntil = (booking.scheduledAt.getTime() - Date.now()) / 60_000;
    if (minsUntil < 20) {
      throw new BadRequestException(
        'Bookings can only be cancelled more than 20 minutes before the scheduled time.',
      );
    }
    booking.status = BookingStatus.CANCELLED;
    if (reason) booking.cancellationReason = reason;
    const saved = await repo.save(booking);
    setImmediate(() => this._notifyBookingCancelled(saved).catch(() => {}));
    return saved;
  }
}
