import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('barber_follows')
export class BarberFollow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column()
  barberId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
