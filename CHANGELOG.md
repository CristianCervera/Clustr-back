# Novedades

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
