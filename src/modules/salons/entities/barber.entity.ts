import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Salon } from './salon.entity';

@Entity('barbers')
export class Barber {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Salon, (salon) => salon.barbers, { onDelete: 'CASCADE' })
  salon!: Salon;

  @Column()
  name!: string;

  @Column()
  experience!: number;
}