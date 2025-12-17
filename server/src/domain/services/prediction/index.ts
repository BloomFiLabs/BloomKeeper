// Main service
export { FundingRatePredictionService } from './FundingRatePredictionService';

// Ensemble predictor
export { EnsemblePredictor } from './EnsemblePredictor';

// Individual predictors
export { MeanReversionPredictor } from './predictors/MeanReversionPredictor';
export { PremiumIndexPredictor } from './predictors/PremiumIndexPredictor';
export { OpenInterestPredictor } from './predictors/OpenInterestPredictor';

// Filters
export { KalmanFilterEstimator } from './filters/KalmanFilterEstimator';
export { RegimeDetector } from './filters/RegimeDetector';

// Backtesting
export { PredictionBacktester } from './PredictionBacktester';
export type { BacktestResults } from './PredictionBacktester';
