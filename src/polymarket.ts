import axios from "axios";

const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://polymarket.com",
  Referer: "https://polymarket.com/",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};

export interface PolyActivity {
  id: string;
  timestamp: number;
  type: string;
  marketTitle: string;
  outcome: string;
  side: string;
  price: number;
  amount: number;
}

export interface PolyPosition {
  title: string;
  outcome: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  currentValue: number;
  marketSlug: string;
  assetId: string;
}

// Cache de usernames para não fazer scraping repetido
const usernameCache = new Map<
  string,
  { username: string; timestamp: number }
>();
const USERNAME_CACHE_TTL = 3600000; // 1 hora

// Cache de portfolio com timestamp para cada carteira
const portfolioSnapshots = new Map<
  string,
  { positions: Map<string, PolyPosition>; timestamp: number }
>();

// 1. RESOLVER USUÁRIO
export async function resolveUser(input: string): Promise<string | null> {
  const cleanInput = input.trim();

  if (/^0x[a-fA-F0-9]{40}$/i.test(cleanInput)) {
    return cleanInput.toLowerCase();
  }

  let slug = cleanInput
    .replace("https://polymarket.com/@", "")
    .replace("https://polymarket.com/profile/", "")
    .replace("@", "")
    .split("?")[0];

  try {
    const profileUrl = `https://polymarket.com/@${slug}`;
    const { data: html } = await axios.get(profileUrl, {
      headers: BROWSER_HEADERS,
      timeout: 8000
    });

    const patterns = [
      /"proxyWallet":"(0x[a-fA-F0-9]{40})"/i,
      /"address":"(0x[a-fA-F0-9]{40})"/i,
      /wallet["|']:\s*["|'](0x[a-fA-F0-9]{40})["|']/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        console.log(`✅ Resolvido @${slug} → ${match[1]}`);
        return match[1].toLowerCase();
      }
    }

    console.warn(`⚠️ Não encontrei endereço para @${slug}`);
    return null;
  } catch (error: any) {
    console.error(`❌ Erro ao resolver @${slug}:`, error.message);
    return null;
  }
}

// 2. BUSCAR ATIVIDADE (Monitora mudanças no portfolio)
export async function fetchRecentActivity(
  address: string
): Promise<PolyActivity[]> {
  try {
    // Busca portfolio atual (SEMPRE busca novo, sem cache aqui)
    const currentPositions = await fetchPortfolioRaw(address);

    if (currentPositions.length === 0) {
      console.log(`   ℹ️ Portfolio vazio`);
      return [];
    }

    // Cria um Map para facilitar comparação (chave: assetId-outcome)
    const currentMap = new Map<string, PolyPosition>();
    currentPositions.forEach((pos) => {
      const key = `${pos.assetId}-${pos.outcome}`;
      currentMap.set(key, pos);
    });

    // Busca snapshot anterior
    const snapshot = portfolioSnapshots.get(address);

    if (!snapshot) {
      // Primeira vez: salva snapshot e NÃO retorna nada (evita detectar histórico antigo)
      console.log(
        `   📸 Snapshot inicial salvo (${currentPositions.length} posições)`
      );
      portfolioSnapshots.set(address, {
        positions: currentMap,
        timestamp: Date.now()
      });
      return [];
    }

    // Compara com snapshot anterior
    const activities: PolyActivity[] = [];
    const previousMap = snapshot.positions;

    // 1. DETECTA NOVAS POSIÇÕES
    for (const [key, current] of currentMap.entries()) {
      if (!previousMap.has(key)) {
        activities.push({
          id: `${key}-new-${Date.now()}`,
          timestamp: Date.now(),
          type: "Trade",
          marketTitle: current.title,
          outcome: current.outcome,
          side: "BUY",
          price: current.entryPrice,
          amount: current.size
        });
        console.log(
          `   🆕 Nova: ${current.title.slice(0, 40)} - ${
            current.outcome
          } (${current.size.toFixed(1)} shares)`
        );
      }
    }

    // 2. DETECTA AUMENTOS/DIMINUIÇÕES
    for (const [key, current] of currentMap.entries()) {
      const previous = previousMap.get(key);

      if (previous) {
        const sizeDiff = current.size - previous.size;

        if (sizeDiff > 0.5) {
          // Aumentou
          // Calcula o preço médio da operação usando a diferença de investimento
          const prevInvested = previous.size * previous.entryPrice;
          const currInvested = current.size * current.entryPrice;
          const investmentDiff = currInvested - prevInvested;
          const avgPrice = investmentDiff / sizeDiff;

          activities.push({
            id: `${key}-increase-${Date.now()}`,
            timestamp: Date.now(),
            type: "Trade",
            marketTitle: current.title,
            outcome: current.outcome,
            side: "BUY",
            price: avgPrice > 0 ? avgPrice : current.currentPrice,
            amount: sizeDiff
          });
          console.log(
            `   📈 Aumentou: ${current.title.slice(0, 40)} +${sizeDiff.toFixed(
              1
            )} shares @ ${avgPrice.toFixed(3)}`
          );
        } else if (sizeDiff < -0.5) {
          // Diminuiu
          // Para vendas, usa o preço atual do mercado (é o melhor que conseguimos sem API de trades)
          activities.push({
            id: `${key}-decrease-${Date.now()}`,
            timestamp: Date.now(),
            type: "Trade",
            marketTitle: current.title,
            outcome: current.outcome,
            side: "SELL",
            price: current.currentPrice,
            amount: Math.abs(sizeDiff)
          });
          console.log(
            `   📉 Vendeu: ${current.title.slice(0, 40)} ${sizeDiff.toFixed(
              1
            )} shares @ ${current.currentPrice.toFixed(3)}`
          );
        }
      }
    }

    // 3. DETECTA POSIÇÕES FECHADAS
    for (const [key, previous] of previousMap.entries()) {
      if (!currentMap.has(key)) {
        activities.push({
          id: `${key}-close-${Date.now()}`,
          timestamp: Date.now(),
          type: "Trade",
          marketTitle: previous.title,
          outcome: previous.outcome,
          side: "SELL",
          price: previous.currentPrice,
          amount: previous.size
        });
        console.log(
          `   🔴 Fechou: ${previous.title.slice(
            0,
            40
          )} (${previous.size.toFixed(1)} shares)`
        );
      }
    }

    // ATUALIZA O SNAPSHOT SEMPRE (mesmo se não houver mudanças)
    // Isso garante que o preço atual seja atualizado para próxima comparação
    portfolioSnapshots.set(address, {
      positions: currentMap,
      timestamp: Date.now()
    });

    if (activities.length > 0) {
      console.log(`   ✅ Detectou ${activities.length} mudança(s)`);
    }

    return activities;
  } catch (error: any) {
    console.error(
      `❌ Erro ao monitorar ${address.slice(0, 8)}:`,
      error.message
    );
    return [];
  }
}

// 3. BUSCAR PORTFOLIO RAW (sem cache, sempre busca novo)
async function fetchPortfolioRaw(address: string): Promise<PolyPosition[]> {
  try {
    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: {
        user: address,
        size_gt: 0.01 // Ignora poeira
      },
      headers: BROWSER_HEADERS,
      timeout: 10000,
      validateStatus: (status) => status < 500
    });

    if (response.status !== 200 || !Array.isArray(response.data)) {
      return [];
    }

    const positions: PolyPosition[] = [];

    for (const pos of response.data) {
      const size = Number(pos.size || 0);
      if (size < 0.01) continue; // Ignora poeira

      // CORRIGIDO: Busca o título do market via API se necessário
      let title = "Unknown Market";
      const marketId = pos.market?.conditionId || pos.conditionId;

      if (pos.market?.question) {
        title = pos.market.question;
      } else if (pos.market?.title) {
        title = pos.market.title;
      } else if (pos.market?.description) {
        title = pos.market.description;
      } else if (marketId) {
        // Tenta buscar informações do market via API
        try {
          const marketReq = await axios.get(
            `${GAMMA_API_URL}/markets/${marketId}`,
            {
              headers: BROWSER_HEADERS,
              timeout: 2000,
              validateStatus: (status) => status < 500
            }
          );

          if (marketReq.data?.question) {
            title = marketReq.data.question;
          } else if (marketReq.data?.title) {
            title = marketReq.data.title;
          }
        } catch {
          // Se falhar, tenta pelo slug
          if (pos.market?.slug) {
            title = pos.market.slug
              .split("-")
              .map(
                (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
              )
              .join(" ");
          } else {
            title = `Market ${pos.asset?.slice(0, 8) || "Unknown"}`;
          }
        }
      } else if (pos.market?.slug) {
        title = pos.market.slug
          .split("-")
          .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
      } else {
        title = `Market ${pos.asset?.slice(0, 8) || "Unknown"}`;
      }

      const slug = pos.market?.slug || "";
      const outcome = pos.outcome || "Unknown";
      const assetId = pos.asset || "";

      const entryPrice = Number(pos.avgPrice || 0);
      let currentPrice = entryPrice;

      // Tenta buscar preço atual
      try {
        const priceReq = await axios.get(`${CLOB_API_URL}/price`, {
          params: { token_id: assetId, side: "mid" },
          headers: BROWSER_HEADERS,
          timeout: 2000,
          validateStatus: (status) => status < 500
        });

        const fetchedPrice = Number(priceReq.data?.price || 0);
        if (fetchedPrice > 0) {
          currentPrice = fetchedPrice;
        }
      } catch {
        // Fallback: usa outcomePrices se disponível
        if (
          pos.market?.outcomePrices &&
          Array.isArray(pos.market.outcomePrices)
        ) {
          const prices = pos.market.outcomePrices.map((p: any) => Number(p));
          if (outcome.toLowerCase() === "yes" && prices[0]) {
            currentPrice = prices[0];
          } else if (outcome.toLowerCase() === "no" && prices[1]) {
            currentPrice = prices[1];
          }
        }
      }

      const invested = size * entryPrice;
      const currentValue = size * currentPrice;
      const pnl = currentValue - invested;
      const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

      positions.push({
        title,
        outcome,
        size,
        entryPrice,
        currentPrice,
        pnl,
        pnlPercent,
        currentValue,
        marketSlug: slug,
        assetId
      });

      await new Promise((r) => setTimeout(r, 50));
    }

    return positions;
  } catch (error: any) {
    console.error(`❌ Erro ao buscar portfolio:`, error.message);
    return [];
  }
}

// 4. BUSCAR PORTFOLIO (para comando /portfolio, com cache de 30s)
const portfolioCache = new Map<
  string,
  { data: PolyPosition[]; timestamp: number }
>();
const CACHE_TTL = 30000;

export async function fetchPortfolio(address: string): Promise<PolyPosition[]> {
  try {
    // Verifica cache
    const cached = portfolioCache.get(address);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`   💾 Usando cache para ${address.slice(0, 8)}`);
      return cached.data;
    }

    console.log(`📊 Buscando portfolio de ${address.slice(0, 8)}...`);
    const positions = await fetchPortfolioRaw(address);

    // Ordena por valor
    positions.sort((a, b) => b.currentValue - a.currentValue);

    console.log(`   └─ ${positions.length} posições ativas`);

    // Salva no cache
    if (positions.length > 0) {
      portfolioCache.set(address, {
        data: positions,
        timestamp: Date.now()
      });
    }

    return positions;
  } catch (error: any) {
    console.error(`❌ Erro no fetchPortfolio:`, error.message);
    return [];
  }
}

// 5. LIMPA CACHE DE UMA CARTEIRA (útil quando desregistrar)
export function clearCache(address: string): void {
  portfolioSnapshots.delete(address);
  portfolioCache.delete(address);
  usernameCache.delete(address);
  console.log(`🗑️ Cache limpo para ${address.slice(0, 8)}`);
}

// 6. BUSCAR USERNAME (com cache)
export async function getUsernameFromAddress(
  address: string
): Promise<string | null> {
  // Verifica cache
  const cached = usernameCache.get(address);
  if (cached && Date.now() - cached.timestamp < USERNAME_CACHE_TTL) {
    return cached.username;
  }

  try {
    // Busca o perfil via scraping
    const profileUrl = `https://polymarket.com/profile/${address}`;
    const { data: html } = await axios.get(profileUrl, {
      headers: BROWSER_HEADERS,
      timeout: 5000
    });

    // Procura pelo username no HTML
    const patterns = [
      /"username":"([^"]+)"/i,
      /"name":"([^"]+)"/i,
      /<title>([^<|]+)/i // Pega do título da página
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1] && !match[1].includes("Polymarket")) {
        const username = match[1].trim();
        // Salva no cache
        usernameCache.set(address, { username, timestamp: Date.now() });
        return username;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

// 7. TESTE DE APIs
export async function testAPIConnection(address: string): Promise<void> {
  console.log(`\n🧪 TESTANDO APIs PARA ${address.slice(0, 8)}...\n`);

  console.log(`1️⃣ Testando DATA /positions...`);
  try {
    const data = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: address },
      headers: BROWSER_HEADERS,
      timeout: 5000,
      validateStatus: () => true
    });
    console.log(`   Status: ${data.status}`);
    console.log(
      `   Dados: ${
        Array.isArray(data.data)
          ? `${data.data.length} items`
          : "formato inválido"
      }`
    );

    if (data.data && data.data[0]) {
      const sample = data.data[0];
      console.log(
        `   Sample title: ${
          sample.market?.question || sample.market?.slug || "N/A"
        }`
      );
      console.log(`   Sample outcome: ${sample.outcome || "N/A"}`);
      console.log(`   Sample size: ${sample.size || "N/A"}`);
    }
  } catch (e: any) {
    console.log(`   ❌ Erro: ${e.message}`);
  }

  console.log(`\n💡 FUNCIONAMENTO ATUAL:`);
  console.log(`   O bot monitora mudanças comparando snapshots do portfolio.`);
  console.log(`   Detecta: novas posições, aumentos, vendas e fechamentos.`);
  console.log(`   ⏱️ Verificação a cada 30s.\n`);
}
