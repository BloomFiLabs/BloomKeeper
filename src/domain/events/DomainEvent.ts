export interface DomainEvent {
  eventId: string;
  occurredOn: Date;
  eventType: string;
}

export abstract class BaseDomainEvent implements DomainEvent {
  public readonly eventId: string;
  public readonly occurredOn: Date;
  public abstract readonly eventType: string;

  constructor(eventType: string) {
    this.eventId = `${eventType}-${Date.now()}-${Math.random()}`;
    this.occurredOn = new Date();
  }
}

