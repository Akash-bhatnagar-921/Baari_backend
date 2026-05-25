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

    const rows = await this.dataSource.query(
      `SELECT id, phone, email, "fullName", role, "passwordHash", "isActive"
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
      admin: { id: user.id, email: user.email, fullName: user.fullName },
    };
  }

  // ── Dashboard stats ────────────────────────────────────────────────────────

  async getDashboardStats() {
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
        (SELECT COUNT(*) FROM offers WHERE "isActive" = true)                            AS "activeOffers"
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
        activeOffers:       Number(s.activeOffers),
      },
      pendingSalons,
    };
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async getUsers(page: number, limit: number, search: string, role: string) {
    const offset = (page - 1) * limit;
    const sp = `%${search}%`;
    const rf = role || null;

    const users = await this.dataSource.query(
      `SELECT u.id, u.phone, u.email, u."fullName", u.role, u."isActive",
              u.gender, u.age, u.created_at AS "createdAt",
              (SELECT COUNT(*) FROM bookings b WHERE b."userId" = u.id::text) AS "bookingCount"
       FROM users u
       WHERE u.role != 'admin'
         AND (u.phone ILIKE $1 OR u.email ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR u.role::text = $2)
       ORDER BY u.created_at DESC
       LIMIT $3 OFFSET $4`,
      [sp, rf, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM users u
       WHERE u.role != 'admin'
         AND (u.phone ILIKE $1 OR u.email ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR u.role::text = $2)`,
      [sp, rf],
    );
    return { users, total: Number(total), page, limit };
  }

  async getUserDetail(id: string) {
    const rows = await this.dataSource.query(
      `SELECT u.id, u.phone, u.email, u."fullName", u.role, u."isActive",
              u.gender, u.age, u.created_at AS "createdAt", u."hasAcceptedTerms"
       FROM users u WHERE u.id = $1::uuid`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('User not found.');

    const bookings = await this.dataSource.query(
      `SELECT id, "salonName", "scheduledAt", status, "totalAmount"
       FROM bookings WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 10`,
      [id],
    );
    return { ...rows[0], recentBookings: bookings };
  }

  async updateUser(id: string, body: { isActive?: boolean; fullName?: string }) {
    const sets: string[] = [];
    const params: any[] = [];

    if (body.isActive !== undefined) {
      params.push(body.isActive);
      sets.push(`"isActive" = $${params.length}`);
    }
    if (body.fullName !== undefined) {
      params.push(body.fullName);
      sets.push(`"fullName" = $${params.length}`);
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

  // ── Salons ─────────────────────────────────────────────────────────────────

  async getSalons(page: number, limit: number, search: string, status: string) {
    const offset = (page - 1) * limit;
    const sp = `%${search}%`;
    const sf = status || null;

    const salons = await this.dataSource.query(
      `SELECT s.id, s.name, s.address, s.city, s.state, s.pincode, s.status,
              s."contactNumber", s."openingTime", s."closingTime", s."isOpen",
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
    const rows = await this.dataSource.query(
      `SELECT s.*, u."fullName" AS "managerName", u.phone AS "managerPhone", u.email AS "managerEmail"
       FROM salons s LEFT JOIN users u ON u.id = s."managerId"::uuid
       WHERE s.id = $1::uuid`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Salon not found.');

    const [stats] = await this.dataSource.query(
      `SELECT COUNT(*) AS "totalBookings",
              COALESCE(SUM(CASE WHEN status='completed' THEN "totalAmount" ELSE 0 END), 0) AS "revenue"
       FROM bookings WHERE "salonId" = $1`,
      [id],
    );
    return { ...rows[0], bookingStats: stats };
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

    // Generate 6-digit secret code
    const { createHmac } = await import('crypto');
    const secretCode = Math.floor(100000 + Math.random() * 900000).toString();
    const secretCodeHash = createHmac('sha256', secretCode).update(secretCode).digest('hex');

    const [salon] = await this.dataSource.query(
      `INSERT INTO salons (
         id, name, address, city, state, pincode, "managerId",
         "contactNumber", "openingTime", "closingTime", "workingDays",
         status, "secretCode", "secretCodeHash",
         "isOpen", rating, "reviewCount", "priorityListing", featured,
         "hasPendingLocation", "locationApproved", created_at
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6::uuid,
         $7, $8, $9, $10,
         'approved', $11, $12,
         true, 0, 0, false, false, false, false, NOW()
       )
       RETURNING id, name, status, "secretCode"`,
      [
        body.name, body.address, body.city, body.state,
        body.pincode || '000000', managerId,
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

  async getBookings(page: number, limit: number, search: string, status: string) {
    const offset = (page - 1) * limit;
    const sp = `%${search}%`;
    const sf = status || null;

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
       ORDER BY b."createdAt" DESC
       LIMIT $3 OFFSET $4`,
      [sp, sf, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM bookings b
       LEFT JOIN users u ON u.id::text = b."userId"
       WHERE (b."salonName" ILIKE $1 OR u.phone ILIKE $1 OR u."fullName" ILIKE $1)
         AND ($2::text IS NULL OR b.status::text = $2)`,
      [sp, sf],
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
}
