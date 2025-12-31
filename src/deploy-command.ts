import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("track")
    .setDescription("Rastreia uma carteira da Polymarket")
    .addStringOption((option) =>
      option
        .setName("input")
        .setDescription("Endereço 0x ou @username da Polymarket")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("untrack")
    .setDescription("Para de rastrear uma carteira")
    .addStringOption((option) =>
      option
        .setName("input")
        .setDescription("Endereço 0x ou @username da Polymarket")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("portfolio")
    .setDescription("Mostra o portfolio de uma carteira")
    .addStringOption((option) =>
      option
        .setName("carteira")
        .setDescription("Endereço 0x ou @username da Polymarket")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("debug")
    .setDescription("Testa conectividade com as APIs da Polymarket")
    .addStringOption((option) =>
      option
        .setName("input")
        .setDescription("Endereço 0x ou @username para testar")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("Lista todas as carteiras rastreadas neste canal"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Mostra ajuda sobre os comandos do bot")
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

(async () => {
  try {
    console.log("🔄 Registrando comandos slash...");

    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: commands
    });

    console.log("✅ Comandos registrados com sucesso!");
  } catch (error) {
    console.error(error);
  }
})();
