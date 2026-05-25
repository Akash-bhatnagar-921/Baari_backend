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
  @ManyToOne(() => SalonFranchiseOwner, {
    nullable: true,
    onDelete: 'SET NULL',
  })
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

  // Pending location update — submitted by the professional.
  @Column({ type: 'float', nullable: true })
  pendingLatitude!: number;

  @Column({ type: 'float', nullable: true })
  pendingLongitude!: number;

  // Human-readable reverse-geocoded address for the pending pin
  @Column({ nullable: true })
  pendingAddress!: string;

  // Pending city / state / pincode submitted for review alongside the address
  @Column({ nullable: true })
  pendingCity!: string;

  @Column({ nullable: true })
  pendingState!: string;

  @Column({ nullable: true })
  pendingPincode!: string;

  // Set to true by the professional when they submit a new location.
  @Column({ default: false })
  hasPendingLocation!: boolean;

  // Admin flips this to true directly in the DB (pgAdmin / TablePlus etc.)
  // to approve the pending location. The app reads it on the next request
  // and auto-promotes the pending coordinates to the live fields.
  @Column({ default: false })
  locationApproved!: boolean;

  // Professional toggles this from the dashboard. Closed salons are hidden
  // from all customer-facing searches.
  @Column({ default: true })
  isOpen!: boolean;

  // Aggregate rating — updated when reviews are submitted
  @Column({ type: 'float', default: 0 })
  rating!: number;

  @Column({ type: 'int', default: 0 })
  reviewCount!: number;

  // Set when professional activates Growth/Premium plan — sorts salon above standard listings
  @Column({ default: false })
  priorityListing!: boolean;

  // Set when professional activates Premium plan — renders a "Featured" badge on salon cards
  @Column({ default: false })
  featured!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
