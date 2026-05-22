import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';
import { User } from './user.entity';
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

  async updateProfile(userId: string, data: any) {
    await this.userRepo.update(userId, data);
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
    basic: 9900,   // ₹99
    pro:   19900,  // ₹199
  };

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
    const validPlans = ['basic', 'pro'];
    if (!validPlans.includes(plan)) {
      throw new BadRequestException('Invalid plan');
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
      return { plan, status: 'active', expiresAt };
    }

    const sub = this.subRepo.create({
      userId,
      plan: plan as SubscriptionPlan,
      status: 'active',
      expiresAt,
    });
    await this.subRepo.save(sub);
    return { plan, status: 'active', expiresAt };
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
    return { message: 'Subscription cancelled' };
  }

  // ─── Wishlist ─────────────────────────────────────────────────────────────

  async addToWishlist(userId: string, salonId: string) {
    const existing = await this.wishlistRepo.findOne({
      where: { userId, salonId },
    });
    if (existing) return { message: 'Already in wishlist', added: false };
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
}
