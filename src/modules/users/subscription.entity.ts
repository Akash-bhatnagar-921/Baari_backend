import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SubscriptionPlan {
  // ── Customer plans ──────────────────────────────────────────────────────────
  FREE    = 'free',
  BASIC   = 'basic',
  PRO     = 'pro',
  // ── Professional plans ───────────────────────────────────────────────────────
  // Starter  ₹299/mo — up to 3 barbers, basic analytics
  // Growth   ₹599/mo — up to 10 barbers, priority listing
  // Premium  ₹999/mo — unlimited barbers, featured badge, advanced analytics
  PROFESSIONAL_STARTER = 'professional_starter',
  PROFESSIONAL_GROWTH  = 'professional_growth',
  PROFESSIONAL_PREMIUM = 'professional_premium',
}

@Entity('subscriptions')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // One active subscription row per user
  @Column({ unique: true })
  userId!: string;

  @Column({
    type: 'enum',
    enum: SubscriptionPlan,
    default: SubscriptionPlan.FREE,
  })
  plan!: SubscriptionPlan;

  @Column({ default: 'active' })
  status!: string; // 'active' | 'cancelled'

  // null for the Free plan (no expiry)
  @Column({ nullable: true, type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
