import chalk from 'chalk';

const LOGO = `
${chalk.cyan(`   ·  ██████╗  ███████╗ ███████╗  █████╗  ██████╗  ·`)}
${chalk.cyan(`   · ██╔════╝  ██╔════╝ ╚══███╔╝ ██╔══██╗ ██╔══██╗ ·`)}
${chalk.cyan(`   · ██║       █████╗     ███╔╝  ███████║ ██████╔╝ ·`)}
${chalk.cyan(`   · ██║       ██╔══╝    ███╔╝   ██╔══██║ ██╔══██╗ ·`)}
${chalk.cyan(`   · ╚██████╗  ███████╗ ███████╗ ██║  ██║ ██║  ██║ ·`)}
${chalk.cyan(`   ·  ╚═════╝  ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ·`)}
${chalk.dim('           AI-powered GitHub issue management')}
`;

export function renderLogo(): void {
  console.log(LOGO);
}

export function clearScreen(): void {
  process.stdout.write('\x1Bc');
}
