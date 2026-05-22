import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('wishlists')
@Unique(['userId', 'salonId']) // prevent duplicate entries
export class Wishlist {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column()
  salonId!: string;

  @CreateDateColumn()
  created_at!: Date;
}
