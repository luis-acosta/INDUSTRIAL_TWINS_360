//! Contenedor de escritorio de INDUSTRIAL TWINS 360.
//!
//! El criterio de reparto entre Rust y TypeScript es el del plan: en Rust sólo
//! lo que la vista web no puede hacer, o no debe. Eso son cuatro cosas:
//!
//!  - el volcado a disco (`fsync`), que el complemento `fs` no expone y sin el
//!    cual el guardado atómico no garantiza nada;
//!  - el almacén de credenciales del sistema, para que el token de telemetría
//!    no pase por la vista web;
//!  - el proxy de telemetría, que es quien usa ese token;
//!  - la información del contenedor, para que la aplicación sepa si corre
//!    empaquetada y con qué versión.
//!
//! Todo lo demás —modelo, validación, persistencia, publicación— está en
//! TypeScript y cubierto por pruebas que se ejecutan sin compilar Rust. Mover
//! lógica aquí la haría más difícil de probar sin ganar nada.

mod secrets;
mod shell;
mod telemetry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Los registros van a archivo y a la consola de depuración,
                // nunca a la vista web: un registro accesible desde la vista
                // es un registro que un script del proyecto podría leer.
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            shell::fsync_path,
            shell::shell_info,
            secrets::secret_set,
            secrets::secret_exists,
            secrets::secret_delete,
            telemetry::telemetry_query,
            telemetry::telemetry_ping,
        ])
        .run(tauri::generate_context!())
        .expect("El contenedor de la aplicación no pudo arrancar");
}
