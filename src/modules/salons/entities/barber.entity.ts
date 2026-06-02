import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
} from 'typeorm';
import { Salon } from './salon.entity';

@Entity('barbers')
export class Barber {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Salon, (salon) => salon.barbers, { onDelete: 'CASCADE' })
  salon!: Salon;

  @Column()
  name!: string;

  @Column({ default: 0 })
  experience!: number;

  /** Comma-separated working days, e.g. "Mon,Tue,Wed,Thu,Fri,Sat". Null = follows salon schedule. */
  @Column({ nullable: true })
  workingDays!: string;

  @Column({ nullable: true })
  specialization!: string;

  @Column({ type: 'text', nullable: true })
  bio!: string;

  @Column({ nullable: true })
  photoUrl!: string;

  /** JSON array of work/portfolio photos: [{url, caption?}] */
  @Column({ type: 'jsonb', nullable: true })
  gallery!: Array<{ url: string; caption?: string }>;

  @Column({ default: true })
  isAvailable!: boolean;

  /** Barber is on leave until this datetime. */
  @Column({ type: 'timestamptz', nullable: true })
  leaveUntil!: Date;

  /** Barber is on break until this datetime. */
  @Column({ type: 'timestamptz', nullable: true })
  breakUntil!: Date;

  /** Optional per-barber opening time override (HH:MM). Null = follows salon. */
  @Column({ nullable: true })
  openingTime!: string;

  /** Optional per-barber closing time override (HH:MM). Null = follows salon. */
  @Column({ nullable: true })
  closingTime!: string;

  @Column({ type: 'int', default: 0 })
  followersCount!: number;

  /** Monthly base salary in local currency. Null = no fixed salary. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  baseSalary!: number;

  /** Commission percentage of completed walk-in / booking revenue (0–100). */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  commissionRate!: number;

  /** fixed | commission | hybrid */
  @Column({ default: 'fixed' })
  salaryType!: string;
}
