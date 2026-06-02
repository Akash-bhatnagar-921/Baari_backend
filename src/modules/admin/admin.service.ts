import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { UserRole } from '../users/user.entity';

@Injectable()
export class AdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ── Password helpers (scrypt, no extra deps) ──────────────────────────────

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  private verifyPassword(stored: string, supplied: string): boolean {
    try {
      const [salt, hash] = stored.split(':');
      const hashBuf = Buffer.from(hash, 'hex');
      const supplied64 = scryptSync(supplied, salt, 64);
      return timingSafeEqual(hashBuf, supplied64);
    } catch {
      return false;
    }
  }

  // ── Schema helpers (idempotent column/table adds) ─────────────────────────

  // ── Static migration flags (run once per process) ────────────────────────

  private static banColumnsReady = false;
  private static complaintsTableReady = false;

  private async ensureBanColumns() {
    if (AdminService.banColumnsReady) return;
    await this.dataSource.query(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS "bannedUntil" TIMESTAMPTZ`);
    await this.dataSource.query(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS "banReason"   TEXT`);
    await this.dataSource.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS "isBanned"    BOOLEAN DEFAULT false`);
    await this.dataSource.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS "bannedUntil" TIMESTAMPTZ`);
    await this.dataSource.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS "banReason"   TEXT`);
    AdminService.banColumnsReady = true;
  }

  private async ensureComplaintsTable() {
    if (AdminService.complaintsTableReady) return;
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        type         VARCHAR(10) NOT NULL CHECK (type IN ('user','salon')),
        "targetId"   TEXT        NOT NULL,
        "reporterId" TEXT        NOT NULL,
        reason       TEXT        NOT NULL,
        description  TEXT,
        severity     VARCHAR(10) NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','major')),
        status       VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','resolved')),
        "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS complaints_target_idx ON complaints ("targetId", severity, status)`,
    );
    AdminService.complaintsTableReady = true;
  }

  private async ensureSubscriptionExtensions() {
    await this.dataSource.query(
      `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS "isAdminGranted" BOOLEAN DEFAULT false`,
    );
  }

  private async ensureCouponAssignmentsTable() {
    await this.ensureCouponsTable();
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS coupon_assignments (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "couponId"  UUID NOT NULL,
        "userId"    UUID NOT NULL,
        "assignedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE("couponId", "userId")
      )
    `);
  }

  private async ensureAdminPermissionsColumn() {
    await this.dataSource.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB`,
    );
  }

  // ── Seed first admin (protected by ADMIN_SEED_SECRET env var) ─────────────

  async seedAdmin(body: {
    password: string;
    phone: string;
    fullName?: string;
    email?: string;
    seedSecret: string;
  }) {
    const secret = this.config.get<string>('ADMIN_SEED_SECRET');
    if (!secret || body.seedSecret !== secret) {
      throw new ForbiddenException('Invalid seed secret.');
    }
    if (!body.password || !body.phone) {
      throw new BadRequestException('password and phone are required.');
    }

    const existing = await this.dataSource.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [body.phone],
    );
    if (existing.length) {
      throw new BadRequestException('Phone already in use.');
    }

    const passwordHash = this.hashPassword(body.password);
    await this.dataSource.query(
      `INSERT INTO users (id, phone, email, role, "fullName", "passwordHash", "isActive",
                          "hasAcceptedTerms", created_at)
       VALUES (gen_random_uuid(), $1, $2, 'admin', $3, $4, true, true, NOW())`,
      [body.phone, body.email ?? null, body.fullName ?? 'Baari Admin', passwordHash],
    );
    return { message: 'Admin account created.' };
  }

  // ── Admin login ────────────────────────────────────────────────────────────

  async adminLogin(phone: string, password: string) {
    if (!phone || !password) {
      throw new BadRequestException('phone and password are required.');
    }
    await this.ensureAdminPermissionsColumn();

    const rows = await this.dataSource.query(
      `SELECT id, phone, email, "fullName", role, "passwordHash", "isActive", permissions
       FROM users WHERE phone = $1 AND role = 'admin' LIMIT 1`,
      [phone],
    );

    if (!rows.length) throw new UnauthorizedException('Invalid credentials.');
    const user = rows[0];

    if (!user.isActive) throw new UnauthorizedException('Account deactivated.');
    if (!user.passwordHash) {
      throw new UnauthorizedException('No password set. Contact the system administrator.');
    }

    if (!this.verifyPassword(user.passwordHash, password)) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const payload = { sub: user.id, phone: user.phone ?? '', role: UserRole.ADMIN };
    return {
      access_token: this.jwtService.sign(payload, { expiresIn: '8h' }),
      admin: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        permissions: user.permissions ?? null, // null = super admin (all access)
      },
    };
  }

  // ── Dashboard stats ────────────────────────────────────────────────────────

  async getDashboardStats() {
    await this.ensureSubscriptionExtensions();
    const [s] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'customer'     AND "isActive" = true)  AS "totalCustomers",
        (SELECT COUNT(*) FROM users WHERE role = 'professional' AND "isActive" = true)  AS "totalProfessionals",
        (SELECT COUNT(*) FROM salons WHERE status = 'approved')                          AS "approvedSalons",
        (SELECT COUNT(*) FROM salons WHERE status = 'pending')                           AS "pendingSalons",
        (SELECT COUNT(*) FROM salons WHERE status = 'rejected')                          AS "rejectedSalons",
        (SELECT COUNT(*) FROM bookings)                                                   AS "totalBookings",
        (SELECT COUNT(*) FROM bookings WHERE DATE("scheduledAt") = CURRENT_DATE)         AS "todayBookings",
        (SELECT COUNT(*) FROM bookings WHERE status = 'completed')                       AS "completedBookings",
        (SELECT COALESCE(SUM("convenienceFee"),0) FROM bookings WHERE status='completed')  AS "totalRevenue",
        (SELECT COALESCE(SUM("convenienceFee"),0) FROM bookings
          WHERE status = 'completed'
            AND DATE_TRUNC('month',"scheduledAt") = DATE_TRUNC('month', CURRENT_DATE))  AS "monthRevenue",
        (SELECT COALESCE(SUM("convenienceFee"),0) FROM bookings
          WHERE status = 'completed'
            AND "scheduledAt" >= DATE_TRUNC('week', CURRENT_DATE))                      AS "weekRevenue",
        (SELECT COALESCE(SUM("convenienceFee"),0) FROM bookings
          WHERE status = 'completed'
            AND DATE_TRUNC('year',"scheduledAt") = DATE_TRUNC('year', CURRENT_DATE))    AS "yearRevenue",
        (SELECT COUNT(*) FROM offers WHERE "isActive" = true)                            AS "activeOffers",
        (SELECT COUNT(*) FROM subscriptions
          WHERE status = 'active' AND plan != 'free'
            AND ("isAdminGranted" = false OR "isAdminGranted" IS NULL)
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW()))                           AS "activeSubscriptions",
        (SELECT COALESCE(SUM(CASE
            WHEN plan = 'basic'                THEN 99
            WHEN plan = 'pro'                  THEN 199
            WHEN plan = 'professional_starter' THEN 299
            WHEN plan = 'professional_growth'  THEN 599
            WHEN plan = 'professional_premium' THEN 999
            ELSE 0 END), 0)
          FROM subscriptions
          WHERE plan != 'free'
            AND ("isAdminGranted" = false OR "isAdminGranted" IS NULL))               AS "subscriptionRevenue",
        (SELECT COALESCE(SUM(CASE
            WHEN plan = 'basic'                THEN 99
            WHEN plan = 'pro'                  THEN 199
            WHEN plan = 'professional_starter' THEN 299
            WHEN plan = 'professional_growth'  THEN 599
            WHEN plan = 'professional_premium' THEN 999
            ELSE 0 END), 0)
          FROM subscriptions
          WHERE plan != 'free'
            AND ("isAdminGranted" = false OR "isAdminGranted" IS NULL)
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) AS "monthSubRevenue",
        (SELECT COALESCE(SUM(CASE
            WHEN plan = 'basic'                THEN 99
            WHEN plan = 'pro'                  THEN 199
            WHEN plan = 'professional_starter' THEN 299
            WHEN plan = 'professional_growth'  THEN 599
            WHEN plan = 'professional_premium' THEN 999
            ELSE 0 END), 0)
          FROM subscriptions
          WHERE plan != 'free'
            AND ("isAdminGranted" = false OR "isAdminGranted" IS NULL)
            AND created_at >= DATE_TRUNC('week', CURRENT_DATE))                      AS "weekSubRevenue",
        (SELECT COALESCE(SUM(CASE
            WHEN plan = 'basic'                THEN 99
            WHEN plan = 'pro'                  THEN 199
            WHEN plan = 'professional_starter' THEN 299
            WHEN plan = 'professional_growth'  THEN 599
            WHEN plan = 'professional_premium' THEN 999
            ELSE 0 END), 0)
          FROM subscriptions
          WHERE plan != 'free'
            AND ("isAdminGranted" = false OR "isAdminGranted" IS NULL)
            AND DATE_TRUNC('year', created_at) = DATE_TRUNC('year', CURRENT_DATE))   AS "yearSubRevenue"
    `);

    const pendingSalons = await this.dataSource.query(`
      SELECT s.id, s.name, s.city, s.state, s.created_at AS "createdAt",
             u."fullName" AS "managerName", u.phone AS "managerPhone"
      FROM salons s
      LEFT JOIN users u ON u.id = s."managerId"::uuid
      WHERE s.status = 'pending'
      ORDER BY s.created_at DESC
      LIMIT 5
    `);

    return {
      stats: {
        totalCustomers:     Number(s.totalCustomers),
        totalProfessionals: Number(s.totalProfessionals),
        approvedSalons:     Number(s.approvedSalons),
        pendingSalons:      Number(s.pendingSalons),
        rejectedSalons:     Number(s.rejectedSalons),
        totalBookings:      Number(s.totalBookings),
        todayBookings:      Number(s.todayBookings),
        completedBookings:  Number(s.completedBookings),
        totalRevenue:       Number(s.totalRevenue),
        monthRevenue:       Number(s.monthRevenue),
        weekRevenue:        Number(s.weekRevenue),
        yearRevenue:        Number(s.yearRevenue),
        activeOffers:          Number(s.activeOffers),
        activeSubscriptions:   Number(s.activeSubscriptions),
        subscriptionRevenue:   Number(s.subscriptionRevenue),
        monthSubRevenue:       Number(s.monthSubRevenue),
        weekSubRevenue:        Number(s.weekSubRevenue),
        yearSubRevenue:        Number(s.yearSubRevenue),
      },
      pendingSalons,
    };
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async getUsers(page: number, limit: number, search: string, role: string, dateFrom?: string, dateTo?: string) {
    await this.ensureBanColumns();
    const offset = (page - 1) * limit;
    const sp = `%${search}%`;
    const rf = role || null;
    const df = dateFrom || null;
    const dt = dateTo || null;

    const users = await this.dataSource.query(
      `SELECT u.id, u.phone, u.email, u."fullName", u.role, u."isActive",
              u."bannedUntil", u."banReason",
              (u."isActive" = false AND (u."bannedUntil" IS NULL OR u."bannedUntil" > NOW())) AS "isBanned",
              u.gender, u.age, u.created_at AS "createdAt",
              (SELECT COUNT(*) FROM bookings b WHERE b."userId" = u.id::text) AS "bookingCount"
       FROM users u
       WHERE u.role != 'admin'
         AND (u.phone ILIKE $1 OR u.email ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR u.role::text = $2)
         AND ($5::date IS NULL OR u.created_at::date >= $5::date)
         AND ($6::date IS NULL OR u.created_at::date <= $6::date)
       ORDER BY u.created_at DESC
       LIMIT $3 OFFSET $4`,
      [sp, rf, limit, offset, df, dt],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM users u
       WHERE u.role != 'admin'
         AND (u.phone ILIKE $1 OR u.email ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR u.role::text = $2)
         AND ($3::date IS NULL OR u.created_at::date >= $3::date)
         AND ($4::date IS NULL OR u.created_at::date <= $4::date)`,
      [sp, rf, df, dt],
    );
    return { users, total: Number(total), page, limit };
  }

  async getUserDetail(id: string) {
    await this.ensureBanColumns();
    await this.ensureComplaintsTable();
    const rows = await this.dataSource.query(
      `SELECT u.id, u.phone, u.email, u."fullName", u.role, u."isActive",
              u."bannedUntil", u."banReason",
              (u."isActive" = false AND (u."bannedUntil" IS NULL OR u."bannedUntil" > NOW())) AS "isBanned",
              u.gender, u.age, u.created_at AS "createdAt", u."hasAcceptedTerms"
       FROM users u WHERE u.id = $1::uuid`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('User not found.');

    // Financial stats from user's own bookings (as customer)
    const [stats] = await this.dataSource.query(
      `SELECT
         COUNT(*)                                                                        AS "bookingCount",
         COUNT(*) FILTER (WHERE status = 'completed')                                   AS "completedCount",
         COUNT(*) FILTER (WHERE status = 'cancelled')                                   AS "cancelledCount",
         COUNT(*) FILTER (WHERE status IN ('pending','confirmed','in_progress'))        AS "activeCount",
         COALESCE(SUM(CASE WHEN status='completed' THEN "totalAmount"::float   ELSE 0 END), 0) AS "totalSpent",
         COALESCE(SUM(CASE WHEN status='completed' THEN "convenienceFee"::float ELSE 0 END), 0) AS "totalConvenienceFees"
       FROM bookings WHERE "userId" = $1`,
      [id],
    );

    // If professional, get their managed salon + its booking stats
    let salon: any = null;
    if (rows[0].role === 'professional') {
      const salons = await this.dataSource.query(
        `SELECT s.id, s.name, s.city, s.state, s.status,
                COALESCE(SUM(CASE WHEN b.status='completed' THEN b."totalAmount"::float    ELSE 0 END), 0) AS "salonRevenue",
                COALESCE(SUM(CASE WHEN b.status='completed' THEN b."convenienceFee"::float ELSE 0 END), 0) AS "salonBaariFee",
                COUNT(b.id) AS "salonBookingCount"
         FROM salons s
         LEFT JOIN bookings b ON b."salonId" = s.id::text
         WHERE s."managerId" = $1::uuid
         GROUP BY s.id, s.name, s.city, s.state, s.status
         LIMIT 1`,
        [id],
      );
      if (salons.length) {
        salon = {
          ...salons[0],
          salonRevenue: Number(salons[0].salonRevenue),
          salonBaariFee: Number(salons[0].salonBaariFee),
          salonBookingCount: Number(salons[0].salonBookingCount),
        };
      }
    }

    const [sub] = await this.dataSource.query(
      `SELECT plan, status, "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM subscriptions WHERE "userId" = $1 LIMIT 1`,
      [id],
    );

    const [complaintStats] = await this.dataSource.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE severity = 'major' AND status != 'resolved') AS "majorActive"
       FROM complaints WHERE "targetId" = $1`,
      [id],
    );

    return {
      ...rows[0],
      bookingCount:         Number(stats.bookingCount),
      completedCount:       Number(stats.completedCount),
      cancelledCount:       Number(stats.cancelledCount),
      activeCount:          Number(stats.activeCount),
      totalSpent:           Number(stats.totalSpent),
      totalConvenienceFees: Number(stats.totalConvenienceFees),
      subscription: sub ?? { plan: 'free', status: 'active', expiresAt: null },
      salon,
      complaintCount:       Number(complaintStats.total),
      majorComplaintCount:  Number(complaintStats.majorActive),
    };
  }

  async getUserBookings(
    id: string,
    page: number,
    limit: number,
    status?: string,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const offset = (page - 1) * limit;
    const sf = status || null;
    const df = dateFrom || null;
    const dt = dateTo   || null;

    const bookings = await this.dataSource.query(
      `SELECT b.id, b."salonName", b."salonId", b."scheduledAt",
              b.status, b."totalAmount"::float AS "totalAmount",
              b."convenienceFee"::float AS "convenienceFee",
              b."totalDuration", b.services, b."cancellationReason", b."createdAt"
       FROM bookings b
       WHERE b."userId" = $1
         AND ($2::text IS NULL OR b.status::text = $2)
         AND ($3::date IS NULL OR b."scheduledAt"::date >= $3::date)
         AND ($4::date IS NULL OR b."scheduledAt"::date <= $4::date)
       ORDER BY b."scheduledAt" DESC
       LIMIT $5 OFFSET $6`,
      [id, sf, df, dt, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM bookings b
       WHERE b."userId" = $1
         AND ($2::text IS NULL OR b.status::text = $2)
         AND ($3::date IS NULL OR b."scheduledAt"::date >= $3::date)
         AND ($4::date IS NULL OR b."scheduledAt"::date <= $4::date)`,
      [id, sf, df, dt],
    );
    return { bookings, total: Number(total), page, limit };
  }

  async updateUser(id: string, body: {
    isActive?: boolean;
    fullName?: string;
    email?: string;
    phone?: string;
    role?: string;
    gender?: string;
    age?: number;
  }) {
    const sets: string[] = [];
    const params: any[] = [];
    const allowed = ['isActive', 'fullName', 'email', 'phone', 'role', 'gender', 'age'] as const;
    for (const key of allowed) {
      if ((body as any)[key] !== undefined) {
        params.push((body as any)[key]);
        sets.push(`"${key}" = $${params.length}`);
      }
    }
    if (!sets.length) throw new BadRequestException('Nothing to update.');
    params.push(id);
    await this.dataSource.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
      params,
    );
    return { updated: true };
  }

  async deleteUser(id: string) {
    const rows = await this.dataSource.query(
      `SELECT role FROM users WHERE id = $1::uuid LIMIT 1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('User not found.');
    if (rows[0].role === 'admin') throw new ForbiddenException('Cannot delete admin accounts.');
    await this.dataSource.query(`DELETE FROM users WHERE id = $1::uuid`, [id]);
    return { deleted: true };
  }

  async adminSetSubscription(userId: string, plan: string, durationDays?: number) {
    const validPlans = ['free', 'basic', 'pro', 'professional_starter', 'professional_growth', 'professional_premium'];
    if (!validPlans.includes(plan)) throw new BadRequestException('Invalid subscription plan.');

    const users = await this.dataSource.query(
      `SELECT id FROM users WHERE id = $1::uuid LIMIT 1`, [userId],
    );
    if (!users.length) throw new NotFoundException('User not found.');

    await this.ensureSubscriptionExtensions();

    let expiresAt: string | null = null;
    if (plan !== 'free' && durationDays && durationDays > 0) {
      const d = new Date();
      d.setDate(d.getDate() + durationDays);
      expiresAt = d.toISOString();
    }

    await this.dataSource.query(
      `INSERT INTO subscriptions ("userId", plan, status, "expiresAt", "isAdminGranted", created_at, updated_at)
       VALUES ($1, $2, 'active', $3, true, NOW(), NOW())
       ON CONFLICT ("userId") DO UPDATE
         SET plan             = EXCLUDED.plan,
             status           = 'active',
             "expiresAt"      = EXCLUDED."expiresAt",
             "isAdminGranted" = true,
             updated_at       = NOW()`,
      [userId, plan, expiresAt],
    );
    return { updated: true, plan, expiresAt };
  }

  async adminCancelSubscription(userId: string) {
    const rows = await this.dataSource.query(
      `SELECT id FROM subscriptions WHERE "userId" = $1 LIMIT 1`, [userId],
    );
    if (!rows.length) throw new NotFoundException('No subscription found for this user.');
    await this.dataSource.query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE "userId" = $1`,
      [userId],
    );
    return { cancelled: true };
  }

  // ── Ban / Unban ────────────────────────────────────────────────────────────

  async banUser(id: string, durationHours: number | null, reason: string) {
    await this.ensureBanColumns();
    const rows = await this.dataSource.query(
      `SELECT id, role FROM users WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('User not found.');
    if (rows[0].role === 'admin') throw new ForbiddenException('Cannot ban admin accounts.');

    const bannedUntil = durationHours && durationHours > 0
      ? new Date(Date.now() + durationHours * 3_600_000).toISOString()
      : null; // null = permanent

    await this.dataSource.query(
      `UPDATE users SET "isActive" = false, "bannedUntil" = $1, "banReason" = $2 WHERE id = $3::uuid`,
      [bannedUntil, reason || 'Banned by admin', id],
    );
    return { banned: true, bannedUntil };
  }

  async unbanUser(id: string) {
    await this.ensureBanColumns();
    const rows = await this.dataSource.query(
      `SELECT id FROM users WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('User not found.');
    await this.dataSource.query(
      `UPDATE users SET "isActive" = true, "bannedUntil" = NULL, "banReason" = NULL WHERE id = $1::uuid`,
      [id],
    );
    return { unbanned: true };
  }

  async banSalon(id: string, durationHours: number | null, reason: string) {
    await this.ensureBanColumns();
    const rows = await this.dataSource.query(
      `SELECT id FROM salons WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Salon not found.');

    const bannedUntil = durationHours && durationHours > 0
      ? new Date(Date.now() + durationHours * 3_600_000).toISOString()
      : null;

    await this.dataSource.query(
      `UPDATE salons SET "isBanned" = true, "bannedUntil" = $1, "banReason" = $2 WHERE id = $3::uuid`,
      [bannedUntil, reason || 'Banned by admin', id],
    );
    return { banned: true, bannedUntil };
  }

  async unbanSalon(id: string) {
    await this.ensureBanColumns();
    const rows = await this.dataSource.query(
      `SELECT id FROM salons WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Salon not found.');
    await this.dataSource.query(
      `UPDATE salons SET "isBanned" = false, "bannedUntil" = NULL, "banReason" = NULL WHERE id = $1::uuid`,
      [id],
    );
    return { unbanned: true };
  }

  // ── Complaints ─────────────────────────────────────────────────────────────

  async getComplaints(page: number, limit: number, type: string, status: string) {
    await this.ensureComplaintsTable();
    const offset = (page - 1) * limit;
    const tf = type || null;
    const sf = status || null;

    const complaints = await this.dataSource.query(
      `SELECT c.id, c.type, c."targetId", c."reporterId", c.reason, c.description,
              c.severity, c.status, c."createdAt", c."updatedAt",
              u."fullName" AS "reporterName", u.phone AS "reporterPhone"
       FROM complaints c
       LEFT JOIN users u ON u.id::text = c."reporterId"
       WHERE ($1::text IS NULL OR c.type = $1)
         AND ($2::text IS NULL OR c.status = $2)
       ORDER BY c."createdAt" DESC
       LIMIT $3 OFFSET $4`,
      [tf, sf, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM complaints
       WHERE ($1::text IS NULL OR type = $1)
         AND ($2::text IS NULL OR status = $2)`,
      [tf, sf],
    );
    return { complaints, total: Number(total), page, limit };
  }

  async resolveComplaint(id: string, status: string) {
    await this.ensureComplaintsTable();
    if (!['reviewed', 'resolved'].includes(status)) {
      throw new BadRequestException('status must be reviewed or resolved');
    }
    await this.dataSource.query(
      `UPDATE complaints SET status = $1, "updatedAt" = NOW() WHERE id = $2::uuid`,
      [status, id],
    );
    return { updated: true };
  }

  // ── Admin Offer management ────────────────────────────────────────────────

  async adminCreateOffer(body: {
    salonId: string;
    title: string;
    description?: string;
    discountPercent?: number;
    validUntil?: string;
  }) {
    if (!body.salonId || !body.title) {
      throw new BadRequestException('salonId and title are required.');
    }
    const salons = await this.dataSource.query(
      `SELECT id, name FROM salons WHERE id = $1::uuid LIMIT 1`, [body.salonId],
    );
    if (!salons.length) throw new NotFoundException('Salon not found.');
    const salonName = salons[0].name as string;

    const [offer] = await this.dataSource.query(
      `INSERT INTO offers ("salonId", "salonName", title, description, "discountPercent", "validUntil", "isActive", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, true, NOW()) RETURNING *`,
      [body.salonId, salonName, body.title, body.description ?? '',
       body.discountPercent ?? 0, body.validUntil ?? null],
    );
    return offer;
  }

  async adminUpdateOffer(id: string, body: {
    title?: string;
    description?: string;
    discountPercent?: number;
    validUntil?: string | null;
    isActive?: boolean;
  }) {
    const rows = await this.dataSource.query(
      `SELECT id FROM offers WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Offer not found.');

    const allowed = ['title', 'description', 'discountPercent', 'validUntil', 'isActive'] as const;
    const sets: string[] = [];
    const params: any[] = [];
    for (const key of allowed) {
      if ((body as any)[key] !== undefined) {
        params.push((body as any)[key]);
        sets.push(`"${key}" = $${params.length}`);
      }
    }
    if (!sets.length) throw new BadRequestException('Nothing to update.');
    params.push(id);
    await this.dataSource.query(
      `UPDATE offers SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`, params,
    );
    return { updated: true };
  }

  // ── Coupon assignments ─────────────────────────────────────────────────────

  async adminAssignCoupon(couponId: string, userIds: string[]) {
    await this.ensureCouponAssignmentsTable();
    const coupon = await this.dataSource.query(
      `SELECT id FROM coupons WHERE id = $1::uuid LIMIT 1`, [couponId],
    );
    if (!coupon.length) throw new NotFoundException('Coupon not found.');
    if (!userIds.length) return { assigned: 0 };

    for (const uid of userIds) {
      await this.dataSource.query(
        `INSERT INTO coupon_assignments ("couponId", "userId")
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT ("couponId", "userId") DO NOTHING`,
        [couponId, uid],
      );
    }
    return { assigned: userIds.length };
  }

  async adminGetCouponAssignees(couponId: string) {
    await this.ensureCouponAssignmentsTable();
    return this.dataSource.query(
      `SELECT ca."userId" AS id, u."fullName", u.phone, u.email, ca."assignedAt"
       FROM coupon_assignments ca
       LEFT JOIN users u ON u.id = ca."userId"
       WHERE ca."couponId" = $1::uuid
       ORDER BY ca."assignedAt" DESC`,
      [couponId],
    );
  }

  async adminRemoveCouponAssignee(couponId: string, userId: string) {
    await this.ensureCouponAssignmentsTable();
    await this.dataSource.query(
      `DELETE FROM coupon_assignments WHERE "couponId" = $1::uuid AND "userId" = $2::uuid`,
      [couponId, userId],
    );
    return { removed: true };
  }

  // ── Sub-admin management ───────────────────────────────────────────────────

  async adminCreateSubAdmin(body: {
    phone: string;
    fullName?: string;
    password: string;
    permissions: Record<string, boolean>;
  }) {
    await this.ensureAdminPermissionsColumn();
    if (!body.phone || !body.password) {
      throw new BadRequestException('phone and password are required.');
    }
    const existing = await this.dataSource.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`, [body.phone],
    );
    if (existing.length) throw new BadRequestException('Phone already in use.');

    const passwordHash = this.hashPassword(body.password);
    const [user] = await this.dataSource.query(
      `INSERT INTO users (id, phone, role, "fullName", "passwordHash", "isActive",
                          "hasAcceptedTerms", permissions, created_at)
       VALUES (gen_random_uuid(), $1, 'admin', $2, $3, true, true, $4, NOW())
       RETURNING id, phone, "fullName", role, "isActive", permissions, created_at AS "createdAt"`,
      [body.phone, body.fullName ?? 'Sub Admin', passwordHash, JSON.stringify(body.permissions)],
    );
    return user;
  }

  async adminListSubAdmins() {
    await this.ensureAdminPermissionsColumn();
    return this.dataSource.query(
      `SELECT id, phone, email, "fullName", "isActive", permissions, created_at AS "createdAt"
       FROM users
       WHERE role = 'admin' AND permissions IS NOT NULL
       ORDER BY created_at DESC`,
    );
  }

  async adminUpdateSubAdminPermissions(id: string, permissions: Record<string, boolean>) {
    await this.ensureAdminPermissionsColumn();
    const rows = await this.dataSource.query(
      `SELECT id FROM users WHERE id = $1::uuid AND role = 'admin' AND permissions IS NOT NULL LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Sub-admin not found.');
    await this.dataSource.query(
      `UPDATE users SET permissions = $1 WHERE id = $2::uuid`,
      [JSON.stringify(permissions), id],
    );
    return { updated: true };
  }

  async adminDeleteSubAdmin(id: string) {
    await this.ensureAdminPermissionsColumn();
    const rows = await this.dataSource.query(
      `SELECT id, permissions FROM users WHERE id = $1::uuid AND role = 'admin' LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Sub-admin not found.');
    if (!rows[0].permissions) throw new ForbiddenException('Cannot delete super admin accounts.');
    await this.dataSource.query(`DELETE FROM users WHERE id = $1::uuid`, [id]);
    return { deleted: true };
  }

  // ── Salons ─────────────────────────────────────────────────────────────────

  async getSalons(page: number, limit: number, search: string, status: string) {
    await this.ensureBanColumns();
    const offset = (page - 1) * limit;
    const sp = `%${search}%`;
    const sf = status || null;

    const salons = await this.dataSource.query(
      `SELECT s.id, s.name, s.address, s.city, s.state, s.pincode, s.status,
              s."contactNumber", s."openingTime", s."closingTime", s."isOpen",
              s."isBanned", s."bannedUntil", s."banReason",
              (COALESCE(s."isBanned", false) = true AND (s."bannedUntil" IS NULL OR s."bannedUntil" > NOW())) AS "isCurrentlyBanned",
              s.rating, s."reviewCount", s.created_at AS "createdAt",
              u."fullName" AS "managerName", u.phone AS "managerPhone", u.email AS "managerEmail",
              (SELECT COUNT(*) FROM bookings b WHERE b."salonId" = s.id::text) AS "bookingCount"
       FROM salons s
       LEFT JOIN users u ON u.id = s."managerId"::uuid
       WHERE (s.name ILIKE $1 OR s.address ILIKE $1 OR s.city ILIKE $1)
         AND ($2::text IS NULL OR s.status::text = $2)
       ORDER BY s.created_at DESC
       LIMIT $3 OFFSET $4`,
      [sp, sf, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM salons s
       WHERE (s.name ILIKE $1 OR s.address ILIKE $1 OR s.city ILIKE $1)
         AND ($2::text IS NULL OR s.status::text = $2)`,
      [sp, sf],
    );
    return { salons, total: Number(total), page, limit };
  }

  async getSalonDetail(id: string) {
    await this.ensureBanColumns();
    await this.ensureComplaintsTable();
    const rows = await this.dataSource.query(
      `SELECT s.*, u."fullName" AS "managerName", u.phone AS "managerPhone", u.email AS "managerEmail",
              (COALESCE(s."isBanned", false) = true AND (s."bannedUntil" IS NULL OR s."bannedUntil" > NOW())) AS "isCurrentlyBanned"
       FROM salons s LEFT JOIN users u ON u.id = s."managerId"::uuid
       WHERE s.id = $1::uuid`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Salon not found.');

    const [stats] = await this.dataSource.query(
      `SELECT
         COUNT(*)                                                                       AS "totalBookings",
         COUNT(*) FILTER (WHERE status = 'completed')                                  AS "completedCount",
         COUNT(*) FILTER (WHERE status = 'cancelled')                                  AS "cancelledCount",
         COUNT(*) FILTER (WHERE status IN ('pending','confirmed','in_progress'))       AS "activeCount",
         COALESCE(SUM(CASE WHEN status='completed' THEN "totalAmount"::float    ELSE 0 END), 0) AS "totalRevenue",
         COALESCE(SUM(CASE WHEN status='completed' THEN "convenienceFee"::float ELSE 0 END), 0) AS "baariFee"
       FROM bookings WHERE "salonId" = $1`,
      [id],
    );
    const managerId = rows[0].managerId as string | null;
    let managerSubscription: any = { plan: 'free', status: 'active', expiresAt: null };
    if (managerId) {
      const [mSub] = await this.dataSource.query(
        `SELECT plan, status, "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM subscriptions WHERE "userId" = $1 LIMIT 1`,
        [managerId],
      );
      if (mSub) managerSubscription = mSub;
    }

    const [complaintStats] = await this.dataSource.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE severity = 'major' AND status != 'resolved') AS "majorActive"
       FROM complaints WHERE "targetId" = $1`,
      [id],
    );

    return {
      ...rows[0],
      bookingStats: {
        totalBookings:  Number(stats.totalBookings),
        completedCount: Number(stats.completedCount),
        cancelledCount: Number(stats.cancelledCount),
        activeCount:    Number(stats.activeCount),
        totalRevenue:   Number(stats.totalRevenue),
        baariFee:       Number(stats.baariFee),
      },
      managerSubscription,
      complaintCount:      Number(complaintStats.total),
      majorComplaintCount: Number(complaintStats.majorActive),
    };
  }

  async getSalonBookings(
    id: string,
    page: number,
    limit: number,
    status?: string,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const offset = (page - 1) * limit;
    const sf = status || null;
    const df = dateFrom || null;
    const dt = dateTo   || null;

    const bookings = await this.dataSource.query(
      `SELECT b.id, b."scheduledAt", b.status,
              b."totalAmount"::float AS "totalAmount",
              b."convenienceFee"::float AS "convenienceFee",
              b."totalDuration", b.services, b."cancellationReason", b."createdAt",
              u."fullName" AS "customerName", u.phone AS "customerPhone"
       FROM bookings b
       LEFT JOIN users u ON u.id::text = b."userId"
       WHERE b."salonId" = $1
         AND ($2::text IS NULL OR b.status::text = $2)
         AND ($3::date IS NULL OR b."scheduledAt"::date >= $3::date)
         AND ($4::date IS NULL OR b."scheduledAt"::date <= $4::date)
       ORDER BY b."scheduledAt" DESC
       LIMIT $5 OFFSET $6`,
      [id, sf, df, dt, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM bookings b
       WHERE b."salonId" = $1
         AND ($2::text IS NULL OR b.status::text = $2)
         AND ($3::date IS NULL OR b."scheduledAt"::date >= $3::date)
         AND ($4::date IS NULL OR b."scheduledAt"::date <= $4::date)`,
      [id, sf, df, dt],
    );
    return { bookings, total: Number(total), page, limit };
  }

  async approveSalon(id: string) {
    await this.dataSource.query(
      `UPDATE salons SET status = 'approved' WHERE id = $1::uuid`, [id],
    );
    return { approved: true };
  }

  async rejectSalon(id: string) {
    await this.dataSource.query(
      `UPDATE salons SET status = 'rejected' WHERE id = $1::uuid`, [id],
    );
    return { rejected: true };
  }

  async createSalonByAdmin(body: {
    name: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    managerPhone: string;
    managerName?: string;
    managerEmail?: string;
    contactNumber?: string;
    openingTime?: string;
    closingTime?: string;
    workingDays?: string;
    isFranchise?: boolean;
    franchiseId?: string;
    franchiseName?: string;
  }) {
    if (!body.name || !body.address || !body.city || !body.state || !body.managerPhone) {
      throw new BadRequestException('name, address, city, state and managerPhone are required.');
    }

    // Find or create the manager user
    const existing = await this.dataSource.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`, [body.managerPhone],
    );
    let managerId: string;
    if (existing.length) {
      managerId = existing[0].id as string;
      await this.dataSource.query(
        `UPDATE users SET role = 'professional', "isActive" = true WHERE id = $1`, [managerId],
      );
    } else {
      const inserted = await this.dataSource.query(
        `INSERT INTO users (id, phone, email, role, "fullName", "isActive", "hasAcceptedTerms", created_at)
         VALUES (gen_random_uuid(), $1, $2, 'professional', $3, true, true, NOW())
         RETURNING id`,
        [body.managerPhone, body.managerEmail ?? null, body.managerName ?? 'Professional'],
      );
      managerId = inserted[0].id as string;
    }

    // Resolve franchise — use existing, create named, or auto-create from salon name
    let franchiseId: string;
    if (body.franchiseId) {
      const found = await this.dataSource.query(
        `SELECT id FROM salon_franchise WHERE id = $1::uuid LIMIT 1`, [body.franchiseId],
      );
      if (!found.length) throw new BadRequestException('Franchise not found.');
      franchiseId = body.franchiseId;
    } else {
      const fname = (body.franchiseName?.trim()) || body.name;
      const [newFranchise] = await this.dataSource.query(
        `INSERT INTO salon_franchise (id, name, created_at)
         VALUES (gen_random_uuid(), $1, NOW()) RETURNING id`,
        [fname],
      );
      franchiseId = newFranchise.id as string;
    }

    // Generate 6-digit secret code
    const { createHmac } = await import('crypto');
    const secretCode = Math.floor(100000 + Math.random() * 900000).toString();
    const secretCodeHash = createHmac('sha256', secretCode).update(secretCode).digest('hex');

    const [salon] = await this.dataSource.query(
      `INSERT INTO salons (
         id, name, address, city, state, pincode, "managerId",
         "franchiseId",
         "contactNumber", "openingTime", "closingTime", "workingDays",
         status, "secretCode", "secretCodeHash",
         "isOpen", rating, "reviewCount", "priorityListing", featured,
         "hasPendingLocation", "locationApproved", created_at
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6::uuid,
         $7::uuid,
         $8, $9, $10, $11,
         'approved', $12, $13,
         true, 0, 0, false, false, false, false, NOW()
       )
       RETURNING id, name, status, "secretCode"`,
      [
        body.name, body.address, body.city, body.state,
        body.pincode || '000000', managerId,
        franchiseId,
        body.contactNumber ?? null,
        body.openingTime ?? '09:00',
        body.closingTime ?? '21:00',
        body.workingDays ?? 'Mon,Tue,Wed,Thu,Fri,Sat',
        secretCode, secretCodeHash,
      ],
    );
    return {
      salon,
      secretCode,
      message: 'Salon onboarded and approved. Share the secret code with the professional.',
    };
  }

  async updateSalon(id: string, body: Record<string, any>) {
    const allowed = [
      'name', 'address', 'city', 'state', 'pincode', 'contactNumber',
      'openingTime', 'closingTime', 'workingDays', 'status',
      'isOpen', 'priorityListing', 'featured',
    ];
    const sets: string[] = [];
    const params: any[] = [];
    for (const key of allowed) {
      if (body[key] !== undefined) {
        params.push(body[key]);
        sets.push(`"${key}" = $${params.length}`);
      }
    }
    if (!sets.length) throw new BadRequestException('Nothing to update.');
    params.push(id);
    await this.dataSource.query(
      `UPDATE salons SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`, params,
    );
    return { updated: true };
  }

  async deleteSalon(id: string) {
    const rows = await this.dataSource.query(
      `SELECT id FROM salons WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Salon not found.');
    await this.dataSource.query(`DELETE FROM salons WHERE id = $1::uuid`, [id]);
    return { deleted: true };
  }

  // ── Bookings ───────────────────────────────────────────────────────────────

  async getBookings(page: number, limit: number, search: string, status: string, dateFrom?: string, dateTo?: string) {
    const offset = (page - 1) * limit;
    const sp = `%${search}%`;
    const sf = status || null;
    const df = dateFrom || null;
    const dt = dateTo || null;

    const bookings = await this.dataSource.query(
      `SELECT b.id, b."salonName", b."scheduledAt", b.status,
              b."totalAmount"::float AS "totalAmount",
              b."convenienceFee"::float AS "convenienceFee",
              b."totalDuration", b."createdAt",
              u."fullName" AS "customerName", u.phone AS "customerPhone"
       FROM bookings b
       LEFT JOIN users u ON u.id::text = b."userId"
       WHERE (b."salonName" ILIKE $1 OR u.phone ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR b.status::text = $2)
         AND ($5::date IS NULL OR b."scheduledAt"::date >= $5::date)
         AND ($6::date IS NULL OR b."scheduledAt"::date <= $6::date)
       ORDER BY b."createdAt" DESC
       LIMIT $3 OFFSET $4`,
      [sp, sf, limit, offset, df, dt],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM bookings b
       LEFT JOIN users u ON u.id::text = b."userId"
       WHERE (b."salonName" ILIKE $1 OR u.phone ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR b.status::text = $2)
         AND ($3::date IS NULL OR b."scheduledAt"::date >= $3::date)
         AND ($4::date IS NULL OR b."scheduledAt"::date <= $4::date)`,
      [sp, sf, df, dt],
    );
    return { bookings, total: Number(total), page, limit };
  }

  async getBookingDetail(id: string) {
    const rows = await this.dataSource.query(
      `SELECT b.id, b."salonId", b."salonName", b."scheduledAt", b.status,
              b."totalAmount"::float AS "totalAmount",
              b."convenienceFee"::float AS "convenienceFee",
              b."totalDuration", b.services, b."bookingOtp",
              b."cancellationReason", b."createdAt",
              u."fullName" AS "customerName", u.phone AS "customerPhone", u.email AS "customerEmail"
       FROM bookings b LEFT JOIN users u ON u.id::text = b."userId"
       WHERE b.id = $1::uuid`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Booking not found.');
    return rows[0];
  }

  // ── Offers ─────────────────────────────────────────────────────────────────

  async getAllOffers(page: number, limit: number) {
    const offset = (page - 1) * limit;
    const offers = await this.dataSource.query(
      `SELECT * FROM offers ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2`, [limit, offset],
    );
    const [{ total }] = await this.dataSource.query(`SELECT COUNT(*) AS total FROM offers`);
    return { offers, total: Number(total), page, limit };
  }

  async deleteOffer(id: string) {
    const rows = await this.dataSource.query(
      `SELECT id FROM offers WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Offer not found.');
    await this.dataSource.query(`DELETE FROM offers WHERE id = $1::uuid`, [id]);
    return { deleted: true };
  }

  // ── Coupons ────────────────────────────────────────────────────────────────

  private async ensureCouponsTable() {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(50) UNIQUE NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        "discountPercent" INT NOT NULL DEFAULT 0,
        "targetType" VARCHAR(20) NOT NULL DEFAULT 'all',
        "validUntil" TIMESTAMPTZ,
        "maxUses" INT,
        "usedCount" INT NOT NULL DEFAULT 0,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async getCoupons(page = 1, limit = 50) {
    await this.ensureCouponsTable();
    const offset = (page - 1) * limit;
    const coupons = await this.dataSource.query(
      `SELECT * FROM coupons ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const [{ total }] = await this.dataSource.query(`SELECT COUNT(*) AS total FROM coupons`);
    return { coupons, total: Number(total) };
  }

  async createCoupon(body: {
    code: string; title: string; description?: string;
    discountPercent: number; targetType?: string;
    validUntil?: string; maxUses?: number;
  }) {
    await this.ensureCouponsTable();
    if (!body.code || !body.title) throw new BadRequestException('code and title are required.');
    const pct = Number(body.discountPercent);
    if (isNaN(pct) || pct < 0 || pct > 100) throw new BadRequestException('discountPercent must be 0–100.');

    const code = body.code.toUpperCase().trim();
    const existing = await this.dataSource.query(
      `SELECT id FROM coupons WHERE code = $1 LIMIT 1`, [code],
    );
    if (existing.length) throw new BadRequestException('Coupon code already exists.');

    const [coupon] = await this.dataSource.query(
      `INSERT INTO coupons (code, title, description, "discountPercent", "targetType", "validUntil", "maxUses")
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [code, body.title, body.description ?? null, pct,
       body.targetType ?? 'all', body.validUntil ?? null, body.maxUses ?? null],
    );
    return coupon;
  }

  async toggleCoupon(id: string) {
    await this.ensureCouponsTable();
    const rows = await this.dataSource.query(
      `SELECT id FROM coupons WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Coupon not found.');
    await this.dataSource.query(
      `UPDATE coupons SET "isActive" = NOT "isActive" WHERE id = $1::uuid`, [id],
    );
    return { updated: true };
  }

  async deleteCoupon(id: string) {
    await this.ensureCouponsTable();
    const rows = await this.dataSource.query(
      `SELECT id FROM coupons WHERE id = $1::uuid LIMIT 1`, [id],
    );
    if (!rows.length) throw new NotFoundException('Coupon not found.');
    await this.dataSource.query(`DELETE FROM coupons WHERE id = $1::uuid`, [id]);
    return { deleted: true };
  }
}
