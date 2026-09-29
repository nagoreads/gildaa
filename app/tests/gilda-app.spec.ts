import { test, expect } from '@playwright/test';

// Función helper para inyectar sesión
const setSession = async (page, modalidad) => {
  await page.addInitScript((data) => {
    window.localStorage.setItem('gilda_sesion', JSON.stringify(data));
  }, { email: 'qa@gilda.club', nombre: 'QA Tester', modalidad: modalidad });
};

test.describe('Gilda UI & Roles Audit', () => {

  test('UI adaptabilidad 320px: Cero desbordamiento horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 }); // Pantalla pequeña
    await setSession(page, 'gilda virtual');
    await page.goto('/');

    // Esperar a que el spinner desaparezca
    await expect(page.locator('#initial-loader')).not.toBeVisible();

    // Comprobar desbordamiento evaluando el scroll del DOM
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    
    expect(hasHorizontalScroll).toBe(false, 'Detectado desbordamiento horizontal en 320px');
    
    // Verificar que no hay errores de consola
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    expect(errors).toHaveLength(0);
  });

  test('Acceso Limitado (gilda cotilla): Bloqueo en Comunidad', async ({ page }) => {
    await setSession(page, 'gilda cotilla');
    await page.goto('/');
    
    // Clic en la pestaña Comunidad del nav (último botón)
    await page.locator('nav button').last().click();
    
    // Debe aparecer el ModalUpgrade con el icono del candado
    const modalUpgrade = page.locator('.fa-lock').locator('..'); 
    await expect(modalUpgrade).toBeVisible();
    await expect(page.locator('text=Acceso restringido')).toBeVisible();
  });

  test('Acceso Parcial (gilda satélite): Bloqueo en Comunidad', async ({ page }) => {
    await setSession(page, 'gilda satélite');
    await page.goto('/');
    
    // Clic en la pestaña Comunidad del nav
    await page.locator('nav button').last().click();
    
    // El candado debe activarse porque 'satélite' es acceso restringido
    await expect(page.locator('text=Acceso restringido')).toBeVisible();
  });

  test('Acceso Completo (gilda virtual): Acceso libre', async ({ page }) => {
    await setSession(page, 'gilda virtual');
    await page.goto('/');
    
    // Clic en la pestaña Comunidad
    await page.locator('nav button').last().click();
    
    // El candado NO debe existir y debe verse "Chat de Lectoras"
    await expect(page.locator('text=Acceso restringido')).not.toBeVisible();
    await expect(page.locator('text=Chat de Lectoras')).toBeVisible();
  });

  test('Modalidad Correo (gilda de papel): Bloqueo total de App', async ({ page }) => {
    await setSession(page, 'gilda de papel');
    await page.goto('/');
    
    // Debe mostrar la pantalla blanca de bloqueo total y el botón cerrar sesión
    await expect(page.locator('text=exclusiva para correo')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Cerrar sesión' })).toBeVisible();
  });
});
