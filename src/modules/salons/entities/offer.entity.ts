import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('offers')
export class Offer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  salonId!: string;

  @Column()
  salonName!: string;

  @Column()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string;

  // 0 = no discount (informational offer); 1–100 = percentage off
  @Column({ type: 'int', default: 0 })
  discountPercent!: number;

  @Column({ type: 'timestamptz', nullable: true })
  validUntil!: Date;

  @Column({ default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
