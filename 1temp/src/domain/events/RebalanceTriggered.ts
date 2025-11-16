import { BaseDomainEvent } from './DomainEvent';

export class RebalanceTriggered extends BaseDomainEvent {
  public readonly eventType = 'RebalanceTriggered';

  constructor(
    public readonly strategyId: string,
    public readonly reason: string
  ) {
    super('RebalanceTriggered');
  }
}

