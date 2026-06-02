import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('barber_attendance')
@Unique(['barberId', 'date'])
export class BarberAttendance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  barberId!: string;

  @Column()
  salonId!: string;

  @Column({ type: 'date' })
  date!: string;

  /** HH:MM format */
  @Column({ nullable: true })
  clockIn!: string;

  /** HH:MM format */
  @Column({ nullable: true })
  clockOut!: string;

  /** present | absent | leave | half_day */
  @Column({ default: 'present' })
  status!: string;

  @Column({ nullable: true })
  notes!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
