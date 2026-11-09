import { prisma } from './db.js';

const arvore: Record<string, string[]> = {
  Dormitório: ['Guarda-roupa', 'Cômodas', 'Mesa de cabeceira', 'Penteadeira', 'Cabeceira', 'Camas (casal e solteiro)', 'Treliches e beliches', 'Bicama auxiliar', 'Bases baú', 'Colchões', 'Infantil'],
  Cozinha: ['Cozinhas', 'Kit cozinhas', 'Fruteiras/balcões/aéreos', 'Gabinetes e pias', 'Fogões e cooktops', 'Mesas de cozinha'],
  Sala: ['Mesas e cadeiras', 'Cristaleiras/buffets/aparadores', 'Mesa de centro', 'Homes', 'Painéis', 'Racks e painéis', 'Racks e bancadas', 'Estofados', 'Poltronas'],
  Escritório: ['Escrivaninhas e mesas', 'Cadeiras'],
  Lavanderia: ['Multiuso e sapateiras', 'Livreiros e estantes', 'Passadeiras e lavadoras'],
  Banheiro: ['Gabinetes, kits e espelheiras'],
};

// Pode ser executado várias vezes: só cria o que ainda não existe.
async function garantir(name: string, parentId: string | null) {
  return (await prisma.category.findFirst({ where: { name, parentId } })) ?? prisma.category.create({ data: { name, parentId } });
}
for (const [pai, filhas] of Object.entries(arvore)) {
  const p = await garantir(pai, null);
  for (const f of filhas) await garantir(f, p.id);
}
console.log('Categorias iniciais conferidas.');
await prisma.$disconnect();
