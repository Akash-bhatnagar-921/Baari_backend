import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('login_otps')
export class LoginOtp {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  phone!: string;

  @Column()
  email!: string;

  @Index()
  @Column()
  otpHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  invalidatedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  blockedUntil!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
