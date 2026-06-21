# "View diario" — fórmulas auto-expandibles

**Problema:** la columna A (`Fecha`) es `=SORT(UNIQUE(Comidas!A2:A))`, que se auto-expande con
las fechas nuevas. Pero B:K eran fórmulas arrastradas fila por fila (`...=$A2`, `$A3`, …) que
solo llegaban hasta una fila vieja → las fechas nuevas quedaban sin fórmula y se leían vacías.

**Fix:** reemplazar B:K por una única fórmula `MAP(A2:A; …)` por columna (en la fila 2), que
spillea hacia abajo y siempre cubre todas las fechas. Mismo estilo que "View semanal/mensual".

## Cómo aplicarlo

1. En "View diario", seleccioná **B2:K** (desde la fila 2 hasta abajo) y **borrá el contenido**
   (las fórmulas viejas arrastradas). Dejá la fila 1 (headers) y la columna A como están.
2. Pegá cada fórmula de abajo en la celda indicada (B2, C2, …, K2). Cada una spillea sola.

> Locale en español → separador de argumentos `;` (no `,`).

## Fórmulas

**B2 — Evento**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(VLOOKUP(d; Eventos!A:B; 2; FALSE); ""))))
```

**C2 — Desayuno**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!C:C & " - " & Comidas!D:D; Comidas!A:A=d; Comidas!B:B="Desayuno")); ""))))
```

**D2 — Almuerzo**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!C:C & " - " & Comidas!D:D; Comidas!A:A=d; Comidas!B:B="Almuerzo")); ""))))
```

**E2 — Merienda**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!C:C & " - " & Comidas!D:D; Comidas!A:A=d; Comidas!B:B="Merienda")); ""))))
```

**F2 — Cena**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!C:C & " - " & Comidas!D:D; Comidas!A:A=d; Comidas!B:B="Cena")); ""))))
```

**G2 — Score (promedio del día)**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(ROUND(AVERAGE(FILTER(Comidas!E:E; Comidas!A:A=d)); 2); ""))))
```

**H2 — Notas Desayuno**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!F:F; Comidas!A:A=d; Comidas!B:B="Desayuno")); ""))))
```

**I2 — Notas Almuerzo**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!F:F; Comidas!A:A=d; Comidas!B:B="Almuerzo")); ""))))
```

**J2 — Notas Merienda**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!F:F; Comidas!A:A=d; Comidas!B:B="Merienda")); ""))))
```

**K2 — Notas Cena**
```
=MAP(A2:A; LAMBDA(d; IF(d=""; ""; IFERROR(TEXTJOIN(""; TRUE; FILTER(Comidas!F:F; Comidas!A:A=d; Comidas!B:B="Cena")); ""))))
```
