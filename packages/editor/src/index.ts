/**
 * @it360/editor — herramientas de autoría.
 *
 * Contiene la lógica del editor que no es interfaz: colocar y mover
 * marcadores, editar polígonos, y proponer conexiones entre escenas. Está
 * separada de los componentes de React por una razón concreta: es la
 * aritmética donde un error no se ve a simple vista —un marcador medio grado
 * desviado parece bien en la pantalla del autor— y aquí se puede comprobar
 * con casos concretos.
 */
export * from './placement';
export * from './autoconnect';
