import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { PushNotificationService } from '../users/push-notification.service';
import { SmsService } from '../auth/services/sms.service';

@Injectable()
export class BookingReminderService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly push: PushNotificationService,
    private readonly sms: SmsService,
  ) {}

  // Runs every 15 minutes — finds confirmed bookings whose appointment falls
  // in the 24h or 1h reminder window and sends push + SMS exactly once each.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sendReminders() {
    const now = new Date();

    // ── 24-hour reminder window: scheduledAt ∈ [now+23h, now+25h] ────────────
    const h24from = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const h24to   = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    // ── 1-hour reminder window: scheduledAt ∈ [now+50min, now+70min] ─────────
    const h1from  = new Date(now.getTime() + 50 * 60 * 1000);
    const h1to    = new Date(now.getTime() + 70 * 60 * 1000);

    // ── 10-minute reminder window: scheduledAt ∈ [now+5min, now+15min] ────────
    const m10from = new Date(now.getTime() +  5 * 60 * 1000);
    const m10to   = new Date(now.getTime() + 15 * 60 * 1000);

    const bookings: Array<Booking & { userPhone?: string }> =
      await this.dataSource.query(
        `SELECT b.*, u.phone AS "userPhone"
         FROM bookings b
         JOIN users u ON u.id = b."userId"::uuid
         WHERE b.status = 'confirmed'
           AND (
             (b."scheduledAt" BETWEEN $1 AND $2 AND b."reminder24hSent"  = false)
             OR
             (b."scheduledAt" BETWEEN $3 AND $4 AND b."reminder1hSent"   = false)
             OR
             (b."scheduledAt" BETWEEN $5 AND $6 AND b."reminder10mSent"  = false)
           )`,
        [h24from, h24to, h1from, h1to, m10from, m10to],
      );

    if (!bookings.length) return;

    const repo = this.dataSource.getRepository(Booking);

    for (const booking of bookings) {
      const scheduledAt = new Date(booking.scheduledAt);
      const dt = new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
      }).format(scheduledAt);

      const is24h  = scheduledAt >= h24from && scheduledAt <= h24to  && !booking.reminder24hSent;
      const is1h   = scheduledAt >= h1from  && scheduledAt <= h1to   && !booking.reminder1hSent;
      const is10m  = scheduledAt >= m10from && scheduledAt <= m10to  && !booking.reminder10mSent;

      if (is24h) {
        await this.push.sendToUser(
          booking.userId,
          'Appointment Tomorrow 📅',
          `Reminder: your appointment at ${booking.salonName} is tomorrow at ${dt}. Your OTP is ${booking.bookingOtp}.`,
          { bookingId: booking.id, type: 'booking_reminder' },
        ).catch(() => {});

        if (booking.userPhone) {
          await this.sms.sendMessage(
            booking.userPhone,
            `Baari Reminder: Your appointment at ${booking.salonName} is tomorrow (${dt}). OTP: ${booking.bookingOtp}`,
          ).catch(() => {});
        }

        await repo.update(booking.id, { reminder24hSent: true });
      }

      if (is1h) {
        await this.push.sendToUser(
          booking.userId,
          'Appointment in 1 Hour ⏰',
          `Your appointment at ${booking.salonName} starts in about 1 hour. OTP: ${booking.bookingOtp}`,
          { bookingId: booking.id, type: 'booking_reminder' },
        ).catch(() => {});

        if (booking.userPhone) {
          await this.sms.sendMessage(
            booking.userPhone,
            `Baari: Your appointment at ${booking.salonName} is in ~1 hour. OTP: ${booking.bookingOtp}`,
          ).catch(() => {});
        }

        await repo.update(booking.id, { reminder1hSent: true });
      }

      if (is10m) {
        await this.push.sendToUser(
          booking.userId,
          'Starting in 10 Minutes! ✂️',
          `Your appointment at ${booking.salonName} starts in ~10 minutes. OTP: ${booking.bookingOtp}`,
          { bookingId: booking.id, type: 'booking_reminder' },
        ).catch(() => {});

        if (booking.userPhone) {
          await this.sms.sendMessage(
            booking.userPhone,
            `Baari: Your appointment at ${booking.salonName} starts in ~10 minutes. OTP: ${booking.bookingOtp}`,
          ).catch(() => {});
        }

        await repo.update(booking.id, { reminder10mSent: true });
      }
    }
  }

  // Runs every 10 minutes — auto-completes confirmed/in_progress bookings whose
  // scheduled end time (scheduledAt + totalDuration) has passed by 3+ minutes.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async autoCompleteExpiredBookings() {
    const bookings: Array<{ id: string; userId: string; salonName: string; userPhone?: string }> =
      await this.dataSource.query(
        `SELECT b.id, b."userId", b."salonName", u.phone AS "userPhone"
         FROM bookings b
         JOIN users u ON u.id = b."userId"::uuid
         WHERE b.status IN ('confirmed', 'in_progress')
           AND b."scheduledAt" + (b."totalDuration" * INTERVAL '1 minute') < NOW() - INTERVAL '3 minutes'`,
      );

    if (!bookings.length) return;

    const ids = bookings.map((b) => b.id);
    await this.dataSource.query(
      `UPDATE bookings SET status = 'completed' WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    for (const booking of bookings) {
      await this.push.sendToUser(
        booking.userId,
        'Appointment Complete!',
        `Your visit to ${booking.salonName} is complete. Hope you enjoyed it! Leave a review.`,
        { bookingId: booking.id, type: 'booking_completed' },
      ).catch(() => {});
    }
  }
}
