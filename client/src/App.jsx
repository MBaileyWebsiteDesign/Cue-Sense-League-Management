import { Suspense, lazy, useState } from 'react';
import { Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import LeagueList from './pages/LeagueList.jsx';
import LeagueDetail from './pages/LeagueDetail.jsx';
import DivisionDetail from './pages/DivisionDetail.jsx';
import TourList from './pages/TourList.jsx';
import TourDetail from './pages/TourDetail.jsx';
import RollOfHonour from './pages/RollOfHonour.jsx';
import FixtureDetail from './pages/FixtureDetail.jsx';
import PlayerProfile from './pages/PlayerProfile.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import RegisterWix from './pages/RegisterWix.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import PlayerPortal from './pages/PlayerPortal.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { BreadcrumbProvider } from './BreadcrumbContext.jsx';
import Breadcrumbs from './components/Breadcrumbs.jsx';

PLACEHOLDER_REST