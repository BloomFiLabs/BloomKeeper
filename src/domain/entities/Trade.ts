import { Amount, Price } from '../value-objects';

export type TradeSide = 'buy' | 'sell';

export interface TradeProps {
  id: string;
  strategyId: string;
  asset: string;
  side: TradeSide;
  amount: Amount;
  price: Price;
  timestamp: Date;
  fees?: Amount;
  slippage?: Amount;
}

export class Trade {
  private constructor(
    public readonly id: string,
    public readonly strategyId: string,
    public readonly asset: string,
    public readonly side: TradeSide,
    public readonly amount: Amount,
    public readonly price: Price,
    public readonly timestamp: Date,
    public readonly fees: Amount,
    public readonly slippage: Amount
  ) {}

  static create(props: TradeProps): Trade {
    return new Trade(
      props.id,
      props.strategyId,
      props.asset,
      props.side,
      props.amount,
      props.price,
      props.timestamp,
      props.fees || Amount.zero(),
      props.slippage || Amount.zero()
    );
  }

  value(): Amount {
    return this.amount.multiply(this.price.value);
  }

  totalCost(): Amount {
    return this.value().add(this.fees).add(this.slippage);
  }
}

