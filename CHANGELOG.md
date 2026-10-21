# Novedades

## 0.5.0

- **Repartir por cabezas.** `POST /group-sets/:id/heads` (`{ group, name }`) crea un reparto nuevo en el que cada
  miembro del grupo elegido encabeza un grupo y el resto se reparte entre ellos con los criterios del reparto. Con
  «matrimonios juntos», el cónyuge de un cabeza va a su grupo; con «separados», a otro. El original no cambia.
- **Volver a mezclar.** `POST /group-sets/:id/remix` reparte de nuevo al resto de un reparto por cabezas; los cabezas se
  quedan y cada grupo conserva el nombre de su cabeza.
- Cada miembro guardado lleva `head` (falso en los repartos antiguos).

## 0.4.0

- **Nombre de cada grupo.** Los repartos guardan `groupNames` (vacío: «Grupo N»), al crearlos y con PATCH.
- **Repartos editables.** `PATCH /group-sets/:id` acepta `layout`, la nueva composición por posiciones de los miembros,
  para mover personas o volver a generar sin perder la copia guardada de cada una.

## 0.3.0

- **Un matrimonio comparte la asistencia.** Al marcar a una persona casada como ocasional (o habitual), su cónyuge pasa a
  tener la misma; también al casarla siendo ocasional y al importar un matrimonio en el que uno lo es.
- Asistencia ocasional (`occasional`) en personas y repartos, con el criterio `spreadOccasional` para repartir a los
  ocasionales entre los grupos.
- `/auth/me/stats` devuelve `couples` (matrimonios) y `occasional`.
