import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

// Stores the business owner of a salon/franchise location.
// Separate from the `users` table (which handles app authentication).
@Entity('salon_franchise_owner')
export class SalonFranchiseOwner {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column()
  phone!: string;

  @Column({ nullable: true })
  email!: string;

  @CreateDateColumn()
  created_at!: Date;
}
