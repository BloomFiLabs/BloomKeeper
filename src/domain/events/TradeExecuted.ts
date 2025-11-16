import { BaseDomainEvent } from './DomainEvent';
import { Trade } from '../entities/Trade';

export class TradeExecuted extends BaseDomainEvent {
  public readonly eventType = 'TradeExecuted';

  constructor(public readonly trade: Trade) {
    super('TradeExecuted');
  }
}

