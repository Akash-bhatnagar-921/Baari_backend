import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

// Represents a franchise brand / group that one or more salons belong to.
// Non-franchise salons also get an auto-generated entry so every salon
// always has a franchiseId.
@Entity('salon_franchise')
export class SalonFranchise {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Not unique — multiple auto-generated entries may share a similar name.
  @Column()
  name!: string;

  @CreateDateColumn()
  created_at!: Date;
}
