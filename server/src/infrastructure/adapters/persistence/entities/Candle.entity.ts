import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('candles')
@Index(['poolAddress', 'timestamp'], { unique: true })
export class CandleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  poolAddress: string;

  @Column()
  timestamp: Date;

  @Column('float')
  open: number;

  @Column('float')
  high: number;

  @Column('float')
  low: number;

  @Column('float')
  close: number;

  @Column('float')
  volume: number;
}
