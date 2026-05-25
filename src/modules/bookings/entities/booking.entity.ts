import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BookingStatus {
  PENDING = 'pending', // customer booked, awaiting professional acceptance
  CONFIRMED = 'confirmed', // professional accepted; OTP generated
  REJECTED = 'rejected', // professional rejected
  IN_PROGRESS = 'in_progress', // OTP verified; service underway
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired', // professional did not respond within 2 minutes
}

export interface BookingServiceItem {
  serviceId: string;
  serviceName: string;
  price: number;
  duration: number; // minutes
}

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column()
  salonId!: string;

  @Column({ nullable: true })
  salonName!: string;

  @Column({ type: 'timestamptz' })
  scheduledAt!: Date;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING,
  })
  status!: BookingStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  convenienceFee!: number;

  @Column({ type: 'int' })
  totalDuration!: number;

  @Column({ type: 'jsonb' })
  services!: BookingServiceItem[];

  // 4-digit OTP generated when professional accepts; cleared after use
  @Column({ nullable: true })
  bookingOtp!: string;

  @Column({ nullable: true, type: 'timestamptz' })
  otpUsedAt!: Date;

  @Column({ nullable: true })
  cancellationReason!: string;

  // Reminder flags — set by BookingReminderService to prevent duplicate sends
  @Column({ default: false })
  reminder24hSent!: boolean;

  @Column({ default: false })
  reminder1hSent!: boolean;

  @Column({ default: false })
  reminder10mSent!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
