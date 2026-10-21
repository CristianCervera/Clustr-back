# clustr-back

API de Clustr: personas, matrimonios y generación de grupos equilibrados.
Node + Fastify 5 + TypeScript, MongoDB con Mongoose, JWT y login con Google.

## Arrancar

```bash
npm install
npm run dev      # http://localhost:3100/api
```

Sin `MONGODB_URI`, en desarrollo arranca un **MongoDB local** que guarda los datos en `~/.clustr/mongo`.
Copia `.env.example` a `.env` para configurar MongoDB, `JWT_SECRET` o Google.

### Login con Google

1. En https://console.cloud.google.com/apis/credentials crea un **ID de cliente OAuth** de tipo «Aplicación web».
2. En «Orígenes de JavaScript autorizados» añade `http://localhost` y `http://localhost:5180` (y tu dominio en producción). El cambio puede tardar unos minutos en aplicarse.
3. Pon el ID en `GOOGLE_CLIENT_ID` (aquí) y en `VITE_GOOGLE_CLIENT_ID` (en `clustr`).

El front recibe un ID token de Google Identity Services y `POST /auth/google` lo verifica. Si ya existía una
cuenta con ese email, se vincula. Sin `GOOGLE_CLIENT_ID` la ruta responde `503`.

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Servidor con recarga automática |
| `npm test` | Tests (algoritmo de grupos + API con MongoDB en memoria) |
| `npm run typecheck` | Comprobación de tipos |
| `npm run build` / `npm start` | Compila a `dist/` y lo ejecuta (producción: exige `MONGODB_URI` y `JWT_SECRET`) |

## Cómo se hacen los grupos (`src/grouping.ts`)

1. Cada matrimonio (si se piden «juntos») es una pieza de 2; el resto, piezas de 1.
2. Se colocan primero los matrimonios y luego los solteros, cada pieza en el grupo donde menos «coste» añade.
3. Una búsqueda local intercambia y mueve piezas entre grupos mientras el coste baje.

El coste penaliza, por orden de peso: separarse del tamaño objetivo, desviarse de la proporción global de
hombres/mujeres, de casados/solteros y de ocasionales (quienes no suelen venir, con más peso para que ningún
grupo se quede cojo), y de la edad media. Con «separados», tener a un matrimonio en el mismo grupo.

## Endpoints

Todas cuelgan de `/api`. 🔒 = requiere `Authorization: Bearer <token>`.

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, password, name, locale? }` → `{ token, user }` |
| POST | `/auth/login` | `{ email, password }` → `{ token, user }` |
| POST | `/auth/google` | `{ credential, locale? }` (ID token de Google) → `{ token, user }` |
| GET/PATCH 🔒 | `/auth/me` | Perfil. PATCH: `{ name?, locale?, theme?, preferences? }` |
| GET 🔒 | `/auth/me/stats` | `{ people, married, couples, occasional, active, groupSets }` (`couples`: matrimonios, no personas casadas) |
| PUT 🔒 | `/auth/me/password` | `{ currentPassword?, newPassword }` (sin la actual si la cuenta es solo de Google) |
| DELETE 🔒 | `/auth/me` | Borra la cuenta con sus personas y repartos |
| GET 🔒 | `/people` | Lista ordenada por nombre |
| POST 🔒 | `/people` | Alta. `spouseId` vincula a los dos. Devuelve `{ person, changed }` |
| PATCH 🔒 | `/people/:id` | Edición parcial. `married: false` o `spouseId: null` rompen el vínculo. Si cambia `occasional`, el cónyuge pasa a tener el mismo |
| DELETE 🔒 | `/people/:id` · `/people` | Borra una persona · todas |
| POST 🔒 | `/people/active` | `{ ids, active }`: quién participa en los grupos |
| POST 🔒 | `/people/import` | `{ people: [...], replace }`. Vincula siempre a los cónyuges por `spouseName`; si no existe, lo crea |
| POST 🔒 | `/groups/generate` | `{ preferences, personIds? }` → `{ groups }` (no guarda; guarda las preferencias) |
| GET/POST 🔒 | `/group-sets` | Repartos guardados · guardar `{ name, preferences, groups: id[][] }` |
| GET/PATCH/DELETE 🔒 | `/group-sets/:id` | Ver · renombrar `{ name }` · borrar |

## Despliegue (Render)

`render.yaml` describe la API como Web Service gratuito en Frankfurt. En Render: **New → Blueprint** y elige este
repositorio. Pide tres valores: `MONGODB_URI` (MongoDB Atlas), `CORS_ORIGIN` (dirección del front) y
`GOOGLE_CLIENT_ID`. `JWT_SECRET` lo genera Render. Cada push a `main` vuelve a desplegar.
