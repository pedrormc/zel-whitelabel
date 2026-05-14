# Project Categorization (template)

> Regra opcional pro Claude detectar quando o dono inicia trabalho num projeto novo e categorizá-lo no vault Obsidian. **Personalize as categorias conforme sua estrutura de vault.**

## Regra (sugerida)

Quando detectar que o dono está iniciando trabalho num NOVO projeto (que não existe ainda no vault), ANTES de qualquer implementação:

1. Perguntar: "Em qual caixa esse projeto se encaixa?"
2. Categorias padrão (edite pra suas):
   - **Pessoal** — projetos pessoais, side projects → pasta `Pessoal/`
   - **Trabalho** — projetos do trabalho principal → pasta `Trabalho/`
   - **Freelancer** — projetos de clientes → pasta `Freelancer/`
   - **Estudos** — projetos de aprendizado → pasta `Estudos/`
3. Criar nota no vault com frontmatter:
   ```yaml
   ---
   title: "Nome do Projeto"
   category: pessoal|trabalho|freelancer|estudos
   status: active
   stack: []
   created: "YYYY-MM-DD"
   updated: "YYYY-MM-DD"
   ---
   ```

## Como detectar "novo projeto"

- Dono menciona um nome de projeto que não existe nas pastas do vault
- Dono pede pra "criar", "iniciar", "começar" algo novo
- O diretório de trabalho é um repo sem nota correspondente no vault

## Não perguntar quando

- Projeto já tem nota no Obsidian (verificar via Read/Glob primeiro)
- É uma tarefa dentro de um projeto existente
- É pergunta genérica, pesquisa, ou config do Claude Code
- É continuação de trabalho já em andamento na sessão

## Customização

Edite este arquivo pra refletir SUA estrutura de vault. Se você não usa Obsidian ou não quer essa lógica, delete este arquivo.
