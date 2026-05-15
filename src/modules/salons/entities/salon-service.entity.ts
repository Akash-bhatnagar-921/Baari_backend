import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Salon } from './salon.entity';
import { Service } from './service.entity';

@Entity('salon_services')
export class SalonService {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Salon, (salon) => salon.services, { onDelete: 'CASCADE' })
  salon!: Salon;

  @ManyToOne(() => Service)
  service!: Service;

  @Column({ nullable: true })
  price!: number;

  @Column({ nullable: true })
  duration!: number;
}