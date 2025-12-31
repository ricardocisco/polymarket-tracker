import { Elysia } from "elysia";
import mongoose from "mongoose";
import { client } from "./bot";
import { startTrackerLoop } from "./tracker";
import { Wallet, Subscription } from "./models";

// Configuração
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/polybot";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;

// 1. Conexão MongoDB
await mongoose.connect(MONGO_URI);
console.log("📦 MongoDB Conectado!");

// 2. Inicializa o Bot Discord
client.login(DISCORD_TOKEN);
client.once("ready", () => {
  console.log(`🤖 Bot logado como ${client.user?.tag}`);

  // Inicia o Worker de Rastreamento
  startTrackerLoop(client);
});

// 3. Servidor Elysia (API Backend)
// Útil para adicionar carteiras via API externa sem usar o Discord
const app = new Elysia()
  .get("/", () => "Polymarket Tracker is Running 🚀")

  .get("/stats", async () => {
    const walletCount = await Wallet.countDocuments();
    const subCount = await Subscription.countDocuments();
    return { wallets_tracked: walletCount, active_channels: subCount };
  })

  .post("/api/track", async ({ body }: any) => {
    const { channelId, walletAddress } = body;
    // Lógica de API para adicionar tracker externamente
    if (!channelId || !walletAddress) throw new Error("Dados inválidos");

    // (Reutilize a lógica de criação do bot.ts aqui se quiser abstrair)
    return { status: "Feature via API implementada" };
  })

  .listen(PORT);

console.log(`🦊 Elysia Backend rodando em http://localhost:${PORT}`);
