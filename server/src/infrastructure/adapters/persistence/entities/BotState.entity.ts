import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('bot_state')
export class BotStateEntity {
  @PrimaryColumn()
  poolId: string; // Using pool address as ID for simplicity

  @Column('float')
  priceLower: number;

  @Column('float')
  priceUpper: number;

  @Column('float')
  lastRebalancePrice: number;

  @Column()
  lastRebalanceAt: Date;

  @Column('float', { nullable: true })
  currentVolatility: number;

  @Column('float', { nullable: true })
  currentHurst: number;

  @Column({ default: true })
  isActive: boolean;
}
