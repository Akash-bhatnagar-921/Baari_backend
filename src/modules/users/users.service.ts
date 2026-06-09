import { BadRequestException, Injectable, NotFoundException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';
import { User, UserRole } from './user.entity';
import { Wishlist } from './wishlist.entity';
import { Subscription, SubscriptionPlan } from './subscription.entity';

@Injectable()
export class UsersService {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Wishlist)
    private wishlistRepo: Repository<Wishlist>,
    @InjectRepository(Subscription)
    private subRepo: Repository<Subscription>,
    private dataSource: DataSource,
  ) {}

  async createUser(data: any): Promise<User> {
    const user = this.userRepo.create(data);
    const savedUser = await this.userRepo.save(user);

    if (Array.isArray(savedUser)) {
      throw new Error('Unexpected array returned');
    }

    return savedUser;
  }

  async findByPhone(phone: string) {
    return this.userRepo.findOne({ where: { phone } });
  }

  async restoreExpiredBan(userId: string) {
    await this.dataSource.query(
      `UPDATE users SET "isActive" = true, "bannedUntil" = NULL, "banReason" = NULL WHERE id = $1::uuid`,
      [userId],
    );
  }

  /**
   * Look up a customer by phone for offline-booking auto-fill.
   * Throws descriptive errors when:
   *  - phone belongs to the requesting professional's own salon
   *  - phone belongs to any non-customer account (professional / admin)
   * Returns { name, phone } on success, null when no account found.
   */
  async lookupCustomerByPhone(
    phone: string,
    requestingUserId: string,
  ): Promise<{ name: string; phone: string } | null> {
    // Block the salon's own contact number
    const salonRows = await this.dataSource.query(
      `SELECT "contactNumber" FROM salons WHERE "managerId" = $1::uuid LIMIT 1`,
      [requestingUserId],
    );
    if (salonRows.length && salonRows[0].contactNumber === phone) {
      throw new ForbiddenException(
        "You can't book a slot under your own salon's phone number",
      );
    }

    const user = await this.userRepo.findOne({ where: { phone } });
    if (!user) return null;

    if (user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException(
        'That phone number belongs to a professional account, not a customer',
      );
    }

    return { name: user.fullName ?? '', phone: user.phone };
  }

  async findByEmail(email: string) {
    return this.userRepo.findOne({ where: { email } });
  }

  async findByPhoneOrEmail(phone: string, email: string) {
    const where: FindOptionsWhere<User>[] = [{ phone }];
    if (email) where.push({ email });
    return this.userRepo.findOne({ where });
  }

  async deleteAccount(userId: string) {
    await this.userRepo.delete(userId);
    return { message: 'Account deleted successfully' };
  }

  async updateProfile(
    userId: string,
    data: { fullName?: string; email?: string; age?: number; gender?: string },
  ) {
    const allowed: Partial<Pick<User, 'fullName' | 'email' | 'age' | 'gender'>> = {};
    if (data.fullName !== undefined) allowed.fullName = data.fullName;
    if (data.email    !== undefined) allowed.email    = data.email;
    if (data.age      !== undefined) allowed.age      = data.age;
    if (data.gender   !== undefined) allowed.gender   = data.gender;
    if (Object.keys(allowed).length) await this.userRepo.update(userId, allowed);
    return { message: 'Profile updated' };
  }

  async getProfile(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    // Attach current subscription — auto-downgrade expired paid plans
    const sub = await this.subRepo.findOne({ where: { userId } });
    let subscriptionPlan = 'free';
    let subscriptionExpiresAt: Date | null = null;

    if (sub) {
      const isExpired =
        sub.plan !== SubscriptionPlan.FREE &&
        sub.expiresAt &&
        new Date() > new Date(sub.expiresAt);
      if (isExpired) {
        await this.subRepo.update(sub.id, {
          plan: SubscriptionPlan.FREE,
          expiresAt: null as any,
        });
      } else {
        subscriptionPlan = sub.plan;
        subscriptionExpiresAt = sub.expiresAt;
      }
    }

    return {
      ...user,
      subscription: {
        plan: subscriptionPlan,
        status: 'active',
        expiresAt: subscriptionExpiresAt,
      },
    };
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────

  async getSubscription(userId: string) {
    const sub = await this.subRepo.findOne({ where: { userId } });
    if (!sub)
      return {
        plan: SubscriptionPlan.FREE,
        status: 'active',
        expiresAt: null,
        createdAt: null,
      };

    // Auto-downgrade expired paid plans to Free
    if (
      sub.plan !== SubscriptionPlan.FREE &&
      sub.expiresAt &&
      new Date() > new Date(sub.expiresAt)
    ) {
      await this.subRepo.update(sub.id, {
        plan: SubscriptionPlan.FREE,
        expiresAt: null as any,
      });
      await this.syncSalonFlags(userId, 'free');
      return {
        plan: SubscriptionPlan.FREE,
        status: 'active',
        expiresAt: null,
        createdAt: sub.created_at,
        wasExpired: true,
      };
    }

    // Treat cancelled subscriptions as free regardless of stored plan value.
    const effectivePlan =
      sub.status === 'cancelled' ? SubscriptionPlan.FREE : sub.plan;

    return {
      plan: effectivePlan,
      status: sub.status,
      expiresAt: sub.status === 'cancelled' ? null : sub.expiresAt,
      createdAt: sub.created_at,
    };
  }

  // ─── Razorpay: plan prices in paise (₹1 = 100 paise) ─────────────────────
  private static readonly PLAN_PRICES: Record<string, number> = {
    // Customer plans
    basic: 9900,   // ₹99/mo
    pro:   19900,  // ₹199/mo
    // Professional plans
    professional_starter: 29900,  // ₹299/mo
    professional_growth:  59900,  // ₹599/mo
    professional_premium: 99900,  // ₹999/mo
  };

  private static readonly PROFESSIONAL_PLANS = new Set([
    'professional_starter', 'professional_growth', 'professional_premium',
  ]);

  async createSubscriptionOrder(userId: string, plan: string) {
    const amount = UsersService.PLAN_PRICES[plan];
    if (!amount) throw new BadRequestException('Invalid plan');

    const keyId     = this.configService.get<string>('RAZORPAY_KEY_ID');
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret) {
      throw new BadRequestException(
        'Payment gateway is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.',
      );
    }

    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        receipt: `baari_sub_${userId.slice(-8)}_${Date.now()}`,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new BadRequestException(`Razorpay order creation failed: ${err}`);
    }

    const order = (await res.json()) as { id: string };
    return { orderId: order.id, amount, currency: 'INR', keyId };
  }

  private verifyRazorpaySignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
    const secret = this.configService.get<string>('RAZORPAY_KEY_SECRET') ?? '';
    const expected = createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    return expected === signature;
  }

  async createSubscription(
    userId: string,
    plan: string,
    payment?: { paymentId: string; orderId: string; signature: string },
  ) {
    const customerPlans = ['basic', 'pro'];
    const allValidPlans = [...customerPlans, ...UsersService.PROFESSIONAL_PLANS];
    if (!allValidPlans.includes(plan)) {
      throw new BadRequestException('Invalid plan');
    }

    // Professional plans can only be purchased by professional-role users.
    if (UsersService.PROFESSIONAL_PLANS.has(plan)) {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user || user.role !== 'professional') {
        throw new BadRequestException('Professional plans are only available for salon professionals.');
      }
    }

    // Verify Razorpay payment when credentials are configured.
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');
    if (keySecret) {
      if (!payment?.paymentId || !payment?.orderId || !payment?.signature) {
        throw new UnauthorizedException('Payment verification fields are required.');
      }
      if (!this.verifyRazorpaySignature(payment.orderId, payment.paymentId, payment.signature)) {
        throw new UnauthorizedException('Payment signature verification failed.');
      }
    }

    // Calculate expiry: 30 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Upsert — one row per user
    const existing = await this.subRepo.findOne({ where: { userId } });
    if (existing) {
      await this.subRepo.update(existing.id, {
        plan: plan as SubscriptionPlan,
        status: 'active',
        expiresAt,
      });
    } else {
      const sub = this.subRepo.create({
        userId,
        plan: plan as SubscriptionPlan,
        status: 'active',
        expiresAt,
      });
      await this.subRepo.save(sub);
    }

    await this.syncSalonFlags(userId, plan);

    // Generate invoice for paid plans (Razorpay payment present)
    let invoiceNumber: string | undefined;
    if (payment?.paymentId && UsersService.PLAN_PRICES[plan]) {
      invoiceNumber = await this.createInvoice({
        userId,
        plan,
        totalAmountPaise: UsersService.PLAN_PRICES[plan],
        paymentId: payment.paymentId,
        orderId:   payment.orderId,
        paymentMode: 'razorpay',
      });
    }

    return { plan, status: 'active', expiresAt, invoiceNumber };
  }

  // ─── Professional subscription info ──────────────────────────────────────────
  // Returns the current professional plan with human-readable feature limits.
  async getProfessionalSubscription(userId: string) {
    const sub = await this.subRepo.findOne({ where: { userId } });
    const isExpired =
      sub &&
      sub.plan !== SubscriptionPlan.FREE &&
      sub.expiresAt &&
      new Date() > new Date(sub.expiresAt);

    if (!sub || isExpired || !UsersService.PROFESSIONAL_PLANS.has(sub.plan)) {
      return {
        plan: 'free',
        status: 'active',
        expiresAt: null,
        features: { maxBarbers: 1, priorityListing: false, featuredBadge: false, analytics: 'basic' },
      };
    }

    const featureMap: Record<string, object> = {
      professional_starter: { maxBarbers: 3,         priorityListing: false, featuredBadge: false, analytics: 'basic'    },
      professional_growth:  { maxBarbers: 10,        priorityListing: true,  featuredBadge: false, analytics: 'standard' },
      professional_premium: { maxBarbers: Infinity,  priorityListing: true,  featuredBadge: true,  analytics: 'advanced' },
    };

    return {
      plan: sub.plan,
      status: sub.status,
      expiresAt: sub.expiresAt,
      features: featureMap[sub.plan] ?? featureMap['professional_starter'],
    };
  }

  async saveFcmToken(userId: string, token: string) {
    await this.userRepo.update(userId, { fcmToken: token || null as any });
    return { saved: true };
  }

  async cancelSubscription(userId: string) {
    await this.subRepo.update(
      { userId },
      {
        plan: SubscriptionPlan.FREE,
        status: 'cancelled',
        expiresAt: null as any,
      },
    );
    await this.syncSalonFlags(userId, 'free');
    return { message: 'Subscription cancelled' };
  }

  // Updates the salon's featured / priorityListing flags to match the professional's active plan.
  private async syncSalonFlags(userId: string, plan: string) {
    const featured = plan === 'professional_premium';
    const priority = plan === 'professional_growth' || plan === 'professional_premium';
    await this.dataSource.query(
      `UPDATE salons SET featured = $1, "priorityListing" = $2 WHERE "managerId" = $3::uuid`,
      [featured, priority, userId],
    );
  }

  // ─── Wishlist ─────────────────────────────────────────────────────────────

  async addToWishlist(userId: string, salonId: string) {
    const existing = await this.wishlistRepo.findOne({
      where: { userId, salonId },
    });
    if (existing) return { message: 'Already in wishlist', added: false };

    // Free plan: max 10 wishlist entries
    const sub = await this.getSubscription(userId);
    if (sub.plan === SubscriptionPlan.FREE) {
      const count = await this.wishlistRepo.count({ where: { userId } });
      if (count >= 10) {
        throw new BadRequestException(
          'WISHLIST_LIMIT: Free plan allows up to 10 saved salons. Upgrade to Basic or Pro for unlimited wishlist.',
        );
      }
    }

    await this.wishlistRepo.save(this.wishlistRepo.create({ userId, salonId }));
    return { message: 'Added to wishlist', added: true };
  }

  async removeFromWishlist(userId: string, salonId: string) {
    await this.wishlistRepo.delete({ userId, salonId });
    return { message: 'Removed from wishlist', removed: true };
  }

  // Returns the full list of wishlisted salons with salon details.
  async getWishlist(userId: string) {
    // Cast salonId/userId to uuid explicitly — the wishlists table stores
    // them as varchar but salons/users use uuid primary keys.
    const rows: any[] = await this.dataSource.query(
      `
      SELECT
        s.id, s.name, s.address, s.city, s.state, s.pincode,
        s."contactNumber", s."openingTime", s."closingTime", s."workingDays",
        s.latitude, s.longitude, s.rating, s."reviewCount", s.status,
        w.created_at AS "wishlistedAt"
      FROM wishlists w
      JOIN salons s ON s.id = w."salonId"::uuid
      WHERE w."userId"::uuid = $1
      ORDER BY w.created_at DESC
      `,
      [userId],
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      city: r.city,
      state: r.state,
      pincode: r.pincode,
      contactNumber: r.contactNumber,
      openingTime: r.openingTime,
      closingTime: r.closingTime,
      workingDays: r.workingDays,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
      rating: parseFloat(r.rating) || 0,
      reviewCount: parseInt(r.reviewCount) || 0,
      status: r.status,
      wishlistedAt: r.wishlistedAt,
    }));
  }

  // Returns only the salonIds — used to sync heart icons in the UI.
  async getWishlistIds(userId: string): Promise<{ ids: string[] }> {
    const entries = await this.wishlistRepo.find({
      where: { userId },
      select: ['salonId'],
    });
    return { ids: entries.map((e) => e.salonId) };
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  private static invoicesTableReady = false;

  private async ensureInvoicesTable() {
    if (UsersService.invoicesTableReady) return;
    await this.dataSource.query(`CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1`);
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceNumber" VARCHAR(30) NOT NULL UNIQUE,
        "userId"        TEXT        NOT NULL,
        plan            VARCHAR(40) NOT NULL,
        "baseAmount"    INTEGER     NOT NULL,
        "taxAmount"     INTEGER     NOT NULL,
        "totalAmount"   INTEGER     NOT NULL,
        "paymentId"     TEXT,
        "orderId"       TEXT,
        "paymentMode"   VARCHAR(20) NOT NULL DEFAULT 'razorpay',
        "customerName"  TEXT,
        "customerPhone" TEXT,
        "customerEmail" TEXT,
        "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS invoices_user_idx ON invoices ("userId", "createdAt" DESC)`,
    );
    UsersService.invoicesTableReady = true;
  }

  private async createInvoice(opts: {
    userId: string;
    plan: string;
    totalAmountPaise: number;
    paymentId?: string;
    orderId?: string;
    paymentMode?: string;
  }) {
    await this.ensureInvoicesTable();
    const year = new Date().getFullYear();
    const [{ seq }] = await this.dataSource.query(`SELECT nextval('invoice_seq') AS seq`);
    const invoiceNumber = `BAARI-${year}-${String(seq).padStart(6, '0')}`;

    const user = await this.userRepo.findOne({ where: { id: opts.userId } });

    // GST-inclusive calculation at 18%: base = total / 1.18
    const total = opts.totalAmountPaise;
    const base  = Math.round(total / 1.18);
    const tax   = total - base;

    await this.dataSource.query(
      `INSERT INTO invoices (
        "invoiceNumber", "userId", plan,
        "baseAmount", "taxAmount", "totalAmount",
        "paymentId", "orderId", "paymentMode",
        "customerName", "customerPhone", "customerEmail"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        invoiceNumber, opts.userId, opts.plan,
        base, tax, total,
        opts.paymentId ?? null, opts.orderId ?? null,
        opts.paymentMode ?? 'razorpay',
        (user as any)?.fullName ?? null,
        user?.phone ?? null,
        user?.email ?? null,
      ],
    );
    return invoiceNumber;
  }

  async getInvoices(userId: string) {
    await this.ensureInvoicesTable();
    return this.dataSource.query(
      `SELECT * FROM invoices WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      [userId],
    );
  }

  async getInvoice(userId: string, invoiceId: string) {
    await this.ensureInvoicesTable();
    const rows = await this.dataSource.query(
      `SELECT * FROM invoices WHERE id = $1 AND "userId" = $2`,
      [invoiceId, userId],
    );
    if (!rows.length) throw new NotFoundException('Invoice not found');
    return rows[0];
  }

  // ── Complaints ─────────────────────────────────────────────────────────────

  private static complaintsReady = false;
  private static banColsReady = false;

  private async ensureComplaintsReady() {
    if (UsersService.complaintsReady) return;
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
    UsersService.complaintsReady = true;
  }

  private async ensureBanColsReady() {
    if (UsersService.banColsReady) return;
    await this.dataSource.query(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS "bannedUntil" TIMESTAMPTZ`);
    await this.dataSource.query(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS "banReason"   TEXT`);
    await this.dataSource.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS "isBanned"    BOOLEAN DEFAULT false`);
    await this.dataSource.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS "bannedUntil" TIMESTAMPTZ`);
    await this.dataSource.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS "banReason"   TEXT`);
    UsersService.banColsReady = true;
  }

  async submitComplaint(
    reporterId: string,
    type: 'user' | 'salon',
    targetId: string,
    reason: string,
    description: string,
    severity: 'minor' | 'major',
  ) {
    if (!['user', 'salon'].includes(type)) throw new BadRequestException('Invalid type.');
    if (!['minor', 'major'].includes(severity)) throw new BadRequestException('Invalid severity.');
    if (!reason?.trim()) throw new BadRequestException('reason is required.');
    if (!targetId?.trim()) throw new BadRequestException('targetId is required.');

    await this.ensureComplaintsReady();

    // Prevent duplicate active complaint from same reporter on same target
    const existing = await this.dataSource.query(
      `SELECT id FROM complaints
       WHERE "reporterId" = $1 AND "targetId" = $2 AND status = 'pending'
       LIMIT 1`,
      [reporterId, targetId],
    );
    if (existing.length) throw new BadRequestException('You already have a pending complaint for this.');

    await this.dataSource.query(
      `INSERT INTO complaints (id, type, "targetId", "reporterId", reason, description, severity, status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())`,
      [type, targetId, reporterId, reason.trim(), description?.trim() ?? null, severity],
    );

    // Auto-ban when a target accumulates 3+ unresolved major complaints
    if (severity === 'major') {
      const [{ count }] = await this.dataSource.query(
        `SELECT COUNT(*) AS count FROM complaints
         WHERE "targetId" = $1 AND severity = 'major' AND status != 'resolved'`,
        [targetId],
      );
      if (Number(count) >= 3) {
        await this.ensureBanColsReady();
        const bannedUntil = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
        const banReason = 'Auto-banned: 3 or more major complaints received.';
        if (type === 'user') {
          await this.dataSource.query(
            `UPDATE users SET "isActive" = false, "bannedUntil" = $1, "banReason" = $2 WHERE id = $3::uuid AND "isActive" = true`,
            [bannedUntil, banReason, targetId],
          );
        } else {
          await this.dataSource.query(
            `UPDATE salons SET "isBanned" = true, "bannedUntil" = $1, "banReason" = $2 WHERE id = $3::uuid AND COALESCE("isBanned", false) = false`,
            [bannedUntil, banReason, targetId],
          );
        }
      }
    }

    return { submitted: true };
  }
}
