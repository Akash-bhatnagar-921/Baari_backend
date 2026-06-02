import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('salon_portfolio')
export class SalonPortfolio {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  salonId!: string;

  /** 'portfolio' = single work photo; 'before_after' = before+after pair. */
  @Column({ default: 'portfolio' })
  type!: string;

  /** Main (or "after") photo URL. */
  @Column()
  photoUrl!: string;

  /** "Before" photo URL — only set for before_after type. */
  @Column({ nullable: true })
  beforeUrl!: string;

  @Column({ nullable: true })
  caption!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
