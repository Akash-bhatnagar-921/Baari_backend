import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('walk_ins')
export class WalkIn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  salonId!: string;

  @Column()
  customerName!: string;

  @Column({ nullable: true })
  customerPhone!: string;

  @Column({ nullable: true })
  barberId!: string;

  @Column({ type: 'jsonb', nullable: true })
  services!: Array<{
    serviceId?: string;
    serviceName: string;
    price: number;
    duration: number;
  }>;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  totalAmount!: number;

  @Column({ type: 'int', default: 0 })
  totalDuration!: number;

  /**
   * When set, this walk-in is a pre-scheduled offline booking.
   * The slot availability query counts it as a busy barber slot so
   * app users see the time is taken.
   */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt!: Date | null;

  /** waiting | in_progress | completed | cancelled */
  @Column({ default: 'waiting' })
  status!: string;

  @Column({ nullable: true })
  notes!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
