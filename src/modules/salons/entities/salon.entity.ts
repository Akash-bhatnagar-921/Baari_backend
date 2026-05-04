import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  Unique,
} from 'typeorm';
import { User } from '../../users/user.entity';
import { Barber } from './barber.entity';
import { SalonService } from './salon-service.entity';

export enum SalonStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('salons')
@Unique(['name', 'address'])
export class Salon {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column()
  address!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  owner!: User;

  @OneToMany(() => Barber, (barber) => barber.salon)
  barbers!: Barber[];

  @OneToMany(() => SalonService, (ss) => ss.salon)
  services!: SalonService[];

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
  image!: string; // S3 URL

  @Column({
    type: 'enum',
    enum: SalonStatus,
    default: SalonStatus.PENDING,
  })
  status!: SalonStatus;
}
