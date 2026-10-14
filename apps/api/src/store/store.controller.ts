import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { Can, CurrentPrincipal, CustomersOnly, EmployeesOnly, Public, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import {
  checkoutSchema,
  confirmationPreviewSchema,
  orderListSchema,
  orderStatusSchema,
  productSchema,
  productUpdateSchema,
  storeSettingsSchema,
  StoreService,
  type ProductInput,
} from './store.service';

/** The store on the public site: products on sale (no sign-in). */
@Controller('site/store')
@Public()
export class SiteStoreController {
  constructor(private readonly store: StoreService) {}

  @Get()
  async index(@Res({ passthrough: true }) res: Response) {
    res.set('Cache-Control', 'public, max-age=60');
    return this.store.publicStore();
  }

  @Get('products/:slug')
  product(@Res({ passthrough: true }) res: Response, @Param('slug') slug: string) {
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new NotFoundException('Product not found');
    res.set('Cache-Control', 'public, max-age=60');
    return this.store.publicProduct(slug);
  }
}

/** Website › Products, for editors (website rights). */
@Controller('products')
@EmployeesOnly()
export class ProductsController {
  constructor(private readonly store: StoreService) {}

  @Get()
  @Can('read', 'website')
  list(@CurrentPrincipal() p: Principal) {
    return this.store.listProducts(p);
  }

  @Post()
  @Can('create', 'website')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(productSchema)) body: ProductInput) {
    return this.store.createProduct(p, body);
  }

  @Put(':id')
  @Can('update', 'website')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(productUpdateSchema)) body: Partial<ProductInput>) {
    return this.store.updateProduct(p, id, body);
  }

  @Delete(':id')
  @Can('delete', 'website')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.store.deleteProduct(p, id);
  }
}

/** Settings › Store. */
@Controller('admin/store')
@EmployeesOnly()
export class StoreSettingsController {
  constructor(private readonly store: StoreService) {}

  @Get()
  @Can('update', 'settings')
  get(@CurrentPrincipal() p: Principal) {
    return this.store.getSettings(p);
  }

  @Put()
  @Can('update', 'settings')
  update(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(storeSettingsSchema)) body: z.infer<typeof storeSettingsSchema>) {
    return this.store.updateSettings(p, body);
  }

  /** The confirmation email for a made-up order, as the template stands in the editor. */
  @Post('confirmation-preview')
  @HttpCode(200)
  @Can('update', 'settings')
  preview(@Body(new ZodPipe(confirmationPreviewSchema)) body: z.infer<typeof confirmationPreviewSchema>) {
    return this.store.previewConfirmation(body.subject, body.body);
  }
}

/** Orders: customers check out their cart and see their orders; staff see and fulfil them (payments rights). */
@Controller('orders')
export class OrdersController {
  constructor(private readonly store: StoreService) {}

  @Post('checkout')
  @CustomersOnly()
  checkout(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>) {
    return this.store.checkoutCart(p, body);
  }

  @Get()
  @Can('read', 'payments')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(orderListSchema)) q: z.infer<typeof orderListSchema>) {
    return this.store.listOrders(p, q);
  }

  @Get(':id')
  @Can('read', 'payments')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.store.getOrder(p, id);
  }

  /** paid → fulfilled (done) and back; pending → cancelled. */
  @Post(':id/status')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('create', 'payments')
  setStatus(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(orderStatusSchema)) body: z.infer<typeof orderStatusSchema>) {
    return this.store.setOrderStatus(p, id, body.status);
  }
}
