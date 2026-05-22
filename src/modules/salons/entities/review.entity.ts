import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('reviews')
@Unique(['userId', 'salonId']) // one review per user per salon (latest wins via upsert)
export class Review {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column()
  salonId!: string;

  @Column({ nullable: true })
  bookingId!: string;

  @Column({ type: 'int' })
  rating!: number; // 1–5

  @Column({ nullable: true, length: 500 })
  comment!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
