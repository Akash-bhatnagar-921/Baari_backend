import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum UserRole {
  CUSTOMER = 'customer',
  PROFESSIONAL = 'professional',
  ADMIN = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  phone!: string;

  @Column({ unique: true, nullable: true })
  email!: string;

  @Column({
    type: 'enum',
    enum: UserRole,
  })
  role!: UserRole;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ nullable: true })
  fullName!: string;

  @Column({ nullable: true })
  age!: number;

  @Column({ nullable: true })
  gender!: string;

  @Column({ default: false })
  hasAcceptedTerms!: boolean;

  @Column({ nullable: true })
  termsAcceptedAt!: Date;

  @Column({ nullable: true })
  termsVersion!: string;

  @Column({ nullable: true })
  fcmToken!: string;

  // Null for OTP-based users; set only for admin accounts (scrypt hash)
  @Column({ nullable: true, select: false })
  passwordHash?: string;

  // Admins can ban a user; banned users cannot log in
  @Column({ default: true })
  isActive!: boolean;
}
