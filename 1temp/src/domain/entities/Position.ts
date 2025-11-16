import { Amount, Price, PnL } from '../value-objects';

export interface PositionProps {
  id: string;
  strategyId: string;
  asset: string;
  amount: Amount;
  entryPrice: Price;
  currentPrice: Price;
  collateralAmount?: Amount;
  borrowedAmount?: Amount;
}

export class Position {
  private constructor(
    public readonly id: string,
    public readonly strategyId: string,
    public readonly asset: string,
    public readonly amount: Amount,
    public readonly entryPrice: Price,
    public readonly currentPrice: Price,
    public readonly collateralAmount: Amount,
    public readonly borrowedAmount: Amount
  ) {}

  static create(props: PositionProps): Position {
    return new Position(
      props.id,
      props.strategyId,
      props.asset,
      props.amount,
      props.entryPrice,
      props.currentPrice,
      props.collateralAmount || Amount.zero(),
      props.borrowedAmount || Amount.zero()
  );
  }

  marketValue(): Amount {
    return this.amount.multiply(this.currentPrice.value);
  }

  entryValue(): Amount {
    return this.amount.multiply(this.entryPrice.value);
  }

  unrealizedPnL(): PnL {
    const currentValue = this.marketValue();
    const entryValue = this.entryValue();
    return PnL.create(currentValue.value - entryValue.value);
  }

  updatePrice(newPrice: Price): Position {
    return Position.create({
      id: this.id,
      strategyId: this.strategyId,
      asset: this.asset,
      amount: this.amount,
      entryPrice: this.entryPrice,
      currentPrice: newPrice,
      collateralAmount: this.collateralAmount,
      borrowedAmount: this.borrowedAmount,
    });
  }

  isLeveraged(): boolean {
    return !this.borrowedAmount.isZero();
  }
}

