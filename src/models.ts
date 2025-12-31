import mongoose, { Schema, Document } from "mongoose";

// Interface da Carteira
export interface IWallet extends Document {
  address: string;
  lastTimestamp: number;
}

// Interface da Inscrição (Quem está ouvindo quem)
export interface ISubscription extends Document {
  channelId: string;
  walletAddress: string;
}

const WalletSchema = new Schema<IWallet>({
  address: { type: String, required: true, unique: true },
  lastTimestamp: { type: Number, default: 0 }
});

const SubscriptionSchema = new Schema<ISubscription>({
  channelId: { type: String, required: true },
  walletAddress: { type: String, required: true, ref: "Wallet" }
});

// Índice composto para evitar que o mesmo canal siga a mesma carteira 2x
SubscriptionSchema.index({ channelId: 1, walletAddress: 1 }, { unique: true });

export const Wallet = mongoose.model<IWallet>("Wallet", WalletSchema);
export const Subscription = mongoose.model<ISubscription>(
  "Subscription",
  SubscriptionSchema
);
