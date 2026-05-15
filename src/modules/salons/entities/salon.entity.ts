import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';
import { Barber } from './barber.entity';
import { SalonService } from './salon-service.entity';
import { SalonFranchise } from './salon-franchise.entity';
import { SalonFranchiseOwner } from './salon-franchise-owner.entity';

export enum SalonStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('salons')
export class Salon {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column()
  address!: string;

  @Column()
  city!: string;

  @Column()
  state!: string;

  @Column()
  pincode!: string;

  @Column({ nullable: true })
  landmark!: string;

  @Column({ nullable: true })
  email!: string;

  @Column({ nullable: true })
  contactNumber!: string;

  // The authenticated user who manages/registered this salon (for login & auth)
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  manager!: User;

  // The business owner record for this location (separate from auth user)
  @ManyToOne(() => SalonFranchiseOwner, { nullable: true, onDelete: 'SET NULL' })
  franchiseOwner!: SalonFranchiseOwner;

  // Every salon belongs to a franchise; non-franchise salons get an auto-generated one
  @ManyToOne(() => SalonFranchise, { nullable: true, onDelete: 'SET NULL' })
  franchise!: SalonFranchise;

  @OneToMany(() => Barber, (barber) => barber.salon)
  barbers!: Barber[];

  @OneToMany(() => SalonService, (ss) => ss.salon)
  services!: SalonService[];

  @Column({ nullable: true })
  image!: string;

  @Column({
    type: 'enum',
    enum: SalonStatus,
    default: SalonStatus.PENDING,
  })
  status!: SalonStatus;

  // Secret code for 2-step professional login
  @Column({ nullable: true })
  secretCode!: string;

  @Column({ nullable: true })
  secretCodeHash!: string;

  // Working hours
  @Column({ nullable: true })
  openingTime!: string;

  @Column({ nullable: true })
  closingTime!: string;

  @Column({ nullable: true })
  workingDays!: string;

  // GPS coordinates — set from device on salon creation
  @Column({ type: 'float', nullable: true })
  latitude!: number;

  @Column({ type: 'float', nullable: true })
  longitude!: number;

  // Aggregate rating — updated when reviews are submitted
  @Column({ type: 'float', default: 0 })
  rating!: number;

  @Column({ type: 'int', default: 0 })
  reviewCount!: number;

  @CreateDateColumn()
  created_at!: Date;
}
