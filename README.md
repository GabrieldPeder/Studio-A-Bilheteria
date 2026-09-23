# Studio A — Bilheteria

Bilheteria estática para o Studio A, pronta para publicar no GitHub Pages. As vendas, reservas e configurações são sincronizadas pelo Firebase Realtime Database; o envio de ingressos por e-mail usa EmailJS diretamente no navegador.

## Estrutura

```text
index.html             # Estrutura da página e carregamento das dependências
assets/
  css/main.css         # Tema, layout responsivo e estilos de impressão
  js/config.js         # Configurações públicas do Firebase e EmailJS
  js/app.js            # Regras da bilheteria, Firebase, check-in e geração de PDF
```

A separação mantém o comportamento atual, mas torna cada responsabilidade mais simples de localizar. O `index.html` carrega `config.js` antes de `app.js`, pois o aplicativo depende das configurações de integrações.

## Desenvolvimento local

Não há etapa de compilação. Para testar localmente, inicie um servidor estático na raiz do repositório:

```bash
python3 -m http.server 8000
```

Depois, abra `http://localhost:8000`. Não abra o HTML diretamente pelo sistema de arquivos: recursos do navegador, como PWA e Firebase, funcionam de forma mais confiável por HTTP(S).

## Configurações

As configurações de Firebase e EmailJS ficam em `assets/js/config.js`. Elas são chaves públicas de cliente — **não** coloque senhas, chaves privadas ou credenciais administrativas nesse arquivo. A proteção dos dados deve permanecer nas regras do Firebase e nas restrições configuradas no EmailJS.

## Publicação no GitHub Pages

Publique a raiz deste repositório como antes. Como os caminhos de CSS e JavaScript são relativos, `index.html` e a pasta `assets/` devem ser enviados juntos na mesma publicação.
