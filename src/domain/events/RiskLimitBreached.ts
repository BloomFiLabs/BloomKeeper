import { BaseDomainEvent } from './DomainEvent';

export class RiskLimitBreached extends BaseDomainEvent {
  public readonly eventType = 'RiskLimitBreached';

  constructor(
    public readonly strategyId: string,
    public readonly limitType: string,
    public readonly currentValue: number,
    public readonly threshold: number
  ) {
    super('RiskLimitBreached');
  }
}

