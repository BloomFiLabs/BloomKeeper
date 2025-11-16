import { BaseDomainEvent } from './DomainEvent';
import { Position } from '../entities/Position';

export class PositionOpened extends BaseDomainEvent {
  public readonly eventType = 'PositionOpened';

  constructor(public readonly position: Position) {
    super('PositionOpened');
  }
}

