import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('inventory_items')
export class InventoryItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  salonId!: string;

  @Column()
  name!: string;

  /** shampoo | color | cream | tools | consumables | other */
  @Column({ nullable: true })
  category!: string;

  @Column({ type: 'decimal', precision: 10, scale: 3, default: 0 })
  quantity!: number;

  /** units | ml | grams | liters | pcs */
  @Column({ default: 'units' })
  unit!: string;

  /** Alert when quantity falls below this */
  @Column({ type: 'decimal', precision: 10, scale: 3, default: 0 })
  minStock!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  costPerUnit!: number;

  @Column({ nullable: true })
  notes!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
