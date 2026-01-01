import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { Wallet, Subscription } from "./models";
import { fetchRecentActivity, getUsernameFromAddress } from "./polymarket";

const CHECK_INTERVAL = 10000; // 10 segundos (mais rápido = preço mais preciso)

// Cache para evitar duplicação de mensagens
const sentMessages = new Map<string, number>(); // key: activityId, value: timestamp
const MESSAGE_CACHE_TTL = 120000; // 2 minutos

export async function startTrackerLoop(client: Client) {
  console.log(`🔥 TRACKER V3 INICIADO`);
  console.log(
    `🎯 Detecta: Novas posições, aumentos, diminuições e fechamentos\n`
  );

  setInterval(async () => {
    try {
      console.log(
        `💓 [${new Date().toLocaleTimeString()}] Verificando carteiras...`
      );

      // Limpa cache de mensagens antigas (garbage collection)
      const now = Date.now();
      for (const [id, timestamp] of sentMessages.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          sentMessages.delete(id);
        }
      }

      const wallets = await Wallet.find();
      console.log(`📊 Total de carteiras monitoradas: ${wallets.length}`);

      for (const wallet of wallets) {
        if (!wallet.address.startsWith("0x")) {
          console.warn(`⚠️ Endereço inválido: ${wallet.address}`);
          continue;
        }

        // Verifica se tem inscrições ativas
        const subs = await Subscription.find({ walletAddress: wallet.address });
        if (subs.length === 0) {
          console.log(
            `⚠️ Carteira ${wallet.address.slice(0, 8)} sem inscrições ativas`
          );
          continue;
        }

        console.log(
          `🔍 Checando ${wallet.address.slice(0, 8)}... (${subs.length} canais)`
        );

        // Busca mudanças no portfolio (compara com snapshot anterior)
        const activities = await fetchRecentActivity(wallet.address);

        if (activities.length === 0) {
          continue; // Não loga nada se não houver mudanças
        }

        // Todas as atividades detectadas são novas (baseadas em diff de portfolio)
        console.log(
          `🚨 MUDANÇA: ${
            activities.length
          } operação(ões) para ${wallet.address.slice(0, 8)}`
        );

        // Busca o username (com cache) UMA VEZ para todas as operações
        const username = await getUsernameFromAddress(wallet.address);
        const displayName = username ? `@${username}` : null;

        // Atualiza timestamp
        await Wallet.updateOne(
          { _id: wallet._id },
          { lastTimestamp: Date.now() }
        );

        // Processa cada trade detectado
        for (const trade of activities) {
          // Verifica se já enviou essa mensagem recentemente (evita duplicação)
          if (sentMessages.has(trade.id)) {
            console.log(`   ⏭️ Pulando duplicata: ${trade.id}`);
            continue;
          }

          console.log(
            `   📤 ${trade.side} ${trade.amount.toFixed(1)} ${
              trade.outcome
            } @ $${trade.price.toFixed(3)}`
          );
          console.log(`      Market: ${trade.marketTitle.slice(0, 50)}`);

          // Detecção de tipo e cor
          let typeLabel = "OPERAÇÃO";
          let color = 0x808080;
          let emoji = "📊";

          const side = (trade.side || "").toUpperCase();

          if (side === "BUY") {
            typeLabel = "COMPROU";
            color = 0x00ff00;
            emoji = "🟢";
          } else if (side === "SELL") {
            typeLabel = "VENDEU";
            color = 0xff0000;
            emoji = "🔴";
          }

          // Monta descrição com ou sem username
          let description = "";
          if (displayName) {
            description = `**Trader:** ${displayName}\n`;
          }
          description += `**Mercado:** ${trade.marketTitle}\n**Posição:** ${trade.outcome}\n**Carteira:** ${wallet.address}`;

          // Cria o embed
          const embed = new EmbedBuilder()
            .setTitle(`${emoji} ${typeLabel}`)
            .setURL(`https://polymarket.com/profile/${wallet.address}`)
            .setColor(color)
            .setDescription(description)
            .addFields(
              {
                name: "💵 Preço",
                value: `$${trade.price.toFixed(3)}`,
                inline: true
              },
              {
                name: "📊 Shares",
                value: `${trade.amount.toFixed(1)}`,
                inline: true
              },
              {
                name: "💰 Valor",
                value: `$${(trade.price * trade.amount).toFixed(2)}`,
                inline: true
              }
            )
            .setFooter({ text: `Detectado via monitoramento de portfolio` })
            .setTimestamp(new Date(trade.timestamp));

          // Envia para todos os canais inscritos
          let sentCount = 0;
          for (const sub of subs) {
            try {
              const channel = client.channels.cache.get(
                sub.channelId
              ) as TextChannel;
              if (channel && channel.isTextBased()) {
                await channel.send({ embeds: [embed] });
                sentCount++;
              }
            } catch (e) {
              console.error(`   ❌ Erro ao enviar para ${sub.channelId}:`, e);
            }
          }

          if (sentCount > 0) {
            // Marca como enviado para evitar duplicação
            sentMessages.set(trade.id, Date.now());
            console.log(`   ✅ Enviado para ${sentCount} canal(is)`);
          }

          // Delay entre mensagens
          await new Promise((r) => setTimeout(r, 500));
        }

        // Pausa entre carteiras (reduzida pois agora usa cache)
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error("❌ Erro no Loop do Tracker:", e);
    }
  }, CHECK_INTERVAL);
}
