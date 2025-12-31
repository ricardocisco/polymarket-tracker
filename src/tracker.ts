import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { Wallet, Subscription } from "./models";
import { fetchRecentActivity } from "./polymarket";

const CHECK_INTERVAL = 15000; // 30 segundos (monitoramento de portfolio)

export async function startTrackerLoop(client: Client) {
  console.log(`🔥 TRACKER V3 INICIADO - Modo Portfolio Monitoring`);
  console.log(`📊 Sistema: Compara snapshots do portfolio a cada 30s`);
  console.log(
    `🎯 Detecta: Novas posições, aumentos, diminuições e fechamentos\n`
  );

  setInterval(async () => {
    try {
      console.log(
        `💓 [${new Date().toLocaleTimeString()}] Verificando carteiras...`
      );

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

        // Log da mudança detectada
        const latest = activities[0];
        console.log(
          `   └─ Detectou: ${latest.side} ${
            latest.outcome
          } @ ${latest.price.toFixed(3)}`
        );

        // Todas as atividades detectadas são novas (baseadas em diff de portfolio)
        const newTrades = activities;

        if (newTrades.length > 0) {
          console.log(
            `🚨 MUDANÇA: ${
              newTrades.length
            } operação(ões) para ${wallet.address.slice(0, 8)}`
          );

          // Atualiza timestamp
          await Wallet.updateOne(
            { _id: wallet._id },
            { lastTimestamp: Date.now() }
          );

          // Processa cada trade detectado
          for (const trade of newTrades) {
            console.log(
              `   📤 Enviando: ${trade.side} ${
                trade.outcome
              } @ ${trade.price.toFixed(2)}`
            );

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

            // Cria o embed
            const embed = new EmbedBuilder()
              .setTitle(`${emoji} ${typeLabel}`)
              .setURL(`https://polymarket.com/profile/${wallet.address}`)
              .setColor(color)
              .setDescription(
                `**Mercado:** ${trade.marketTitle || "Desconhecido"}\n` +
                  `**Posição:** ${trade.outcome}\n` +
                  `**Carteira:** [\`${wallet.address.slice(
                    0,
                    6
                  )}...${wallet.address.slice(
                    -4
                  )}\`](https://polymarket.com/profile/${wallet.address})`
              )
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
            for (const sub of subs) {
              try {
                const channel = client.channels.cache.get(
                  sub.channelId
                ) as TextChannel;
                if (channel && channel.isTextBased()) {
                  await channel.send({ embeds: [embed] });
                  console.log(`   ✅ Enviado para canal ${sub.channelId}`);
                } else {
                  console.warn(
                    `   ⚠️ Canal ${sub.channelId} não encontrado ou inválido`
                  );
                }
              } catch (e) {
                console.error(`   ❌ Erro ao enviar para ${sub.channelId}:`, e);
              }
            }

            // Delay entre mensagens
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // Pausa entre carteiras (reduzida pois agora usa cache)
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error("❌ Erro no Loop do Tracker:", e);
    }
  }, CHECK_INTERVAL);
}
