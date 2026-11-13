//! Punto de entrada del ejecutable.
//!
//! La lógica vive en la biblioteca (`lib.rs`) para que sus funciones se puedan
//! probar con `cargo test`: un `main.rs` con todo dentro no es comprobable.

// Sin consola en Windows en compilación de publicación: una ventana negra
// detrás de la aplicación parece un error al usuario.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    industrial_twins_360_lib::run()
}
